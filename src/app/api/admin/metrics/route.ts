/**
 * GET /api/admin/metrics — the operator's numbers, admin-gated:
 *   1. mentor conversations (total + per user, with names)
 *   2. résumé edits (user_edit sources)
 *   3. applications sent
 *   4. agent runs by agent — count, errors, avg latency, tokens (the ROI view)
 */
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireAdmin } from "@/lib/auth/admin";
import { queueStatus } from "@/lib/voice/queue";

export const runtime = "nodejs";

export async function GET() {
  const adminId = await requireAdmin();
  if (!adminId) return NextResponse.json({ error: "Not authorized" }, { status: 403 });

  // SEQUENTIAL on purpose: parallel fan-out demanded 4+ fresh pool connections,
  // and the Supabase pooler path intermittently hangs new connects — one warm
  // socket doing 8 tiny queries is ~1s healthy and survives network flaps.
  const run = async <T,>(qs: Array<() => Promise<T>>) => {
    const out: T[] = [];
    for (const q of qs) out.push(await q());
    return out;
  };
  const [calls, callsByUser, edits, apps, agents, recentRuns, activity, byModel, spendByUser, mentorInsights, pastCalls, latestUsers] = await run<unknown>([
    () => db.execute(sql`select count(*)::int as n from sources where kind = 'mentor_call'`),
    () => db.execute(sql`
      select coalesce(p.full_name, p.email, 'unknown') as who, count(*)::int as n, max(s.created_at) as last_at
      from sources s join profiles p on p.id = s.profile_id
      where s.kind = 'mentor_call'
      group by 1 order by n desc limit 20`),
    () => db.execute(sql`
      select count(*)::int as total,
             count(distinct profile_id)::int as users
      from sources where kind = 'user_edit'`),
    () => db.execute(sql`
      select count(*)::int as total,
             count(distinct a.profile_id)::int as users,
             count(*) filter (where a.applied_at > now() - interval '7 days')::int as last7
      from applications a`),
    () => db.execute(sql`
      select agent,
             count(*)::int as runs,
             count(*) filter (where status = 'error')::int as errors,
             round(avg(duration_ms))::int as avg_ms,
             coalesce(sum(input_tokens), 0)::int as tokens_in,
             coalesce(sum(output_tokens), 0)::int as tokens_out,
             max(created_at) as last_at
      from agent_runs
      group by agent order by runs desc`),
    () => db.execute(sql`
      select agent, status, model, duration_ms, error, created_at
      from agent_runs order by created_at desc limit 15`),
    // "active users" proxy until real session logging exists: a profile counts as
    // active if ANY of its rows (sources = uploads/edits/calls, agent runs) were
    // created in the window. Registered = total profiles.
    () => db.execute(sql`
      select
        (select count(distinct profile_id)::int from sources where created_at > now() - interval '1 day') as active_today,
        (select count(distinct profile_id)::int from sources where created_at > now() - interval '7 days') as active_week,
        (select count(*)::int from profiles) as registered,
        (select count(*)::int from profiles where created_at > now() - interval '7 days') as new_week`),
    // per-model totals — real $ from OpenRouter (cost_usd) when logged, else the
    // client multiplies tokens by a price map for an estimate
    () => db.execute(sql`
      select coalesce(model, '(unlogged)') as model,
             count(*)::int as runs,
             coalesce(sum(input_tokens), 0)::int as tokens_in,
             coalesce(sum(output_tokens), 0)::int as tokens_out,
             coalesce(sum(cost_usd), 0)::float8 as cost_usd
      from agent_runs
      group by 1 order by cost_usd desc, runs desc`),
    // per-USER spend — the ask: who costs what. Real $ when logged. Names
    // resolve via the profileId FK OR the userId stashed in meta (worker/system
    // runs have no profile).
    () => db.execute(sql`
      select coalesce(p.full_name, p.email, pm.full_name, pm.email, ar.meta->>'userId', 'system') as who,
             count(*)::int as runs,
             count(*) filter (where ar.agent = 'mentor_turn')::int as turns,
             coalesce(sum(ar.cost_usd), 0)::float8 as cost_usd,
             coalesce(sum(ar.input_tokens), 0)::int as tokens_in,
             coalesce(sum(ar.output_tokens), 0)::int as tokens_out,
             max(ar.created_at) as last_at
      from agent_runs ar
      left join profiles p on p.id = ar.profile_id
      left join profiles pm on pm.user_id::text = (ar.meta->>'userId')
      group by 1 order by cost_usd desc, runs desc limit 30`),
    // the mentor's diary: what the mentor has LEARNED — the live insight map,
    // newest first (stance shows conviction vs exploration from reconcile-A)
    () => db.execute(sql`
      select i.dimension, left(i.content, 160) as content,
             i.data->>'stance' as stance, i.confidence::float8 as confidence,
             coalesce(p.full_name, p.email, 'unknown') as who, i.created_at
      from insights i join profiles p on p.id = i.profile_id
      where i.status = 'active'
      order by i.created_at desc limit 20`),
    // … and what calls already happened (continuity recaps)
    () => db.execute(sql`
      select c.created_at, c.duration_sec, left(c.summary, 140) as summary,
             coalesce(p.full_name, p.email, 'unknown') as who
      from mentor_calls c join profiles p on p.id = c.profile_id
      order by c.created_at desc limit 15`),
    // newest signups — who just joined. Scrollable list (up to 50), with a couple
    // of "did they activate" signals so the operator can see engagement at a glance.
    () => db.execute(sql`
      select coalesce(p.full_name, p.email, 'anon') as who, p.email,
             p.created_at, (p.linkedin_sub is not null) as linkedin,
             (select count(*)::int from experiences e where e.profile_id = p.id) as exp,
             (select count(*)::int from sources s where s.profile_id = p.id and s.kind = 'mentor_call') as calls,
             (select count(*)::int from applications a where a.profile_id = p.id) as applied
      from profiles p order by p.created_at desc limit 50`),
  ]);

  return NextResponse.json({
    ok: true,
    mentorCalls: { total: (calls as unknown as { n: number }[])[0]?.n ?? 0, byUser: callsByUser },
    resumeEdits: (edits as unknown as { total: number; users: number }[])[0] ?? { total: 0, users: 0 },
    applications: (apps as unknown as { total: number; users: number; last7: number }[])[0] ?? { total: 0, users: 0, last7: 0 },
    activity: (activity as unknown as { active_today: number; active_week: number; registered: number; new_week: number }[])[0] ?? null,
    byModel,
    spendByUser,
    agents,
    recentRuns,
    latestUsers,
    mentorDiary: { lane: queueStatus(), insights: mentorInsights, pastCalls },
  });
}
