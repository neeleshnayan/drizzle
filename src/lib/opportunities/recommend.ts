/**
 * Node entry point for recommendations. The RANKING MATH lives in ./rank-core
 * (pure, shared with the Supabase Edge ranker); this file is the Node-side glue:
 * fetch the inputs via the get_ranking_inputs RPC, resolve the scoring vector
 * (cache/recompute — needs the big model, Node-only), embed the direction with
 * local nomic to fill trajDist, then hand off to rankFromInputs.
 *
 * On Cloudflare this path is NOT used for the heavy blend — the Worker calls the
 * Supabase Edge Function (supabase/functions/rank), which runs the same
 * rankFromInputs where the data lives. See docs/adr-001-ranking-funnel.md.
 */
import { sql } from "drizzle-orm";
import { withScopedDb } from "@/db";
import { computeAndSaveScoring, recomputeScoringInBackground } from "@/lib/scoring/persist";
import { TRUSTED_MODELS } from "@/lib/jobs/vectorize";
import { embedBge } from "@/lib/embeddings";
import { rankFromInputs, type RankedJob, type RankOutcome, type RpcInputs } from "./rank-core";
import type { ScoringVector } from "@/lib/scoring/schema";

export type { RankedJob, RankOutcome } from "./rank-core";

/**
 * On Cloudflare the ranking blend runs in the Supabase Edge Function `rank`
 * (where the data lives) — the free Worker (10ms CPU) can't blend hundreds of
 * pool rows in-process. This is ONE fetch, near-zero Worker CPU. On Node we
 * rank locally (rankMatchesWithMeta). See docs/adr-001-ranking-funnel.md.
 */
export async function rankViaEdge(userId: string): Promise<RankOutcome> {
  const url = process.env.RANK_FN_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("RANK_FN_URL / SUPABASE_ANON_KEY not configured");
  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ userId, trusted: TRUSTED_MODELS }),
  });
  if (!r.ok) throw new Error(`rank fn ${r.status}`);
  const out = (await r.json()) as RankOutcome;
  return {
    matches: out.matches ?? [],
    learning: out.learning ?? { active: false, events: 0, confidence: 0 },
    userSkillKeys: out.userSkillKeys ?? [],
  };
}

/** Ranked matches, ROUTED by runtime: Edge Function on CF (cheap Worker), local
 *  blend on Node. Every non-dashboard caller (mentor spectrum, apply-fit,
 *  insight report) goes through here, so none of them blend the pool in the
 *  Worker. The dashboard route calls rankViaEdge / rankMatchesWithMeta directly
 *  because it also needs learning + skillRadar from the full outcome. */
export async function rankMatches(userId: string): Promise<RankedJob[]> {
  if (process.env.DEPLOY_TARGET === "cloudflare") {
    return (await rankViaEdge(userId)).matches;
  }
  return (await rankMatchesWithMeta(userId)).matches;
}

/** unwrap postgres-js (row array) vs node-postgres (Result.rows) */
function rows<T>(res: unknown): T[] {
  return (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as T[];
}

/**
 * drizzle's `sql` expands an interpolated JS array into a param LIST `($1,$2,…)`,
 * which Postgres reads as a `record` — so `${jsArray}::text[]` throws 42846
 * "cannot cast type record to text[]". Bind a Postgres array LITERAL as a single
 * scalar param instead, then cast THAT (`$1::text[]` / `$1::uuid[]` are valid).
 * Elements are double-quoted (safe for text[], uuid[], etc.) and escaped.
 */
function pgArrayLit(xs: readonly string[]): string {
  return `{${xs.map((x) => `"${String(x).replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
}

export async function rankMatchesWithMeta(userId: string, opts?: { wait?: boolean }): Promise<RankOutcome> {
  const empty: RankOutcome = { matches: [], learning: { active: false, events: 0, confidence: 0 }, userSkillKeys: [] };
  // ONE round-trip: every ranking input, gathered WHERE THE DATA LIVES — the
  // get_ranking_inputs Postgres RPC (tools/create-ranking-rpc.ts). withScopedDb
  // gives CF a fresh, in-request-closed client (leftover sockets poisoned isolates);
  // on Node it's the shared pool.
  const rpcRes = await withScopedDb((d) =>
    d.execute(sql`SELECT get_ranking_inputs(${userId}::uuid, ${pgArrayLit(TRUSTED_MODELS)}::text[], null) AS inputs`),
  );
  const inputs = rows<{ inputs: RpcInputs }>(rpcRes)[0]?.inputs;
  if (!inputs) return empty;

  // No résumé yet → recommendations would be noise, AND computing a scoring
  // vector below burns a (paid) LLM call for a profile with nothing to score.
  // Show nothing until they've uploaded something with substance. A mentor-only
  // user (insights but no résumé) still has no evidence to rank on, so gate on
  // résumé content specifically.
  const hasResume = (inputs.experiences?.length ?? 0) > 0 || (inputs.skills?.length ?? 0) > 0;
  if (!hasResume) return empty;

  const me = inputs.profile;

  // scoring vector: fresh cache → serve; missing (brand-new user) → compute inline;
  // stale → serve cached + refresh in the background (Node only — a floating
  // promise wedges a Worker isolate); explicit Refresh (wait) recomputes inline.
  let base = (me?.scoring ?? null) as unknown as ScoringVector | null;
  const stale = !!me?.scoringStale;
  if (!base) {
    try { base = (await computeAndSaveScoring(userId)) as unknown as ScoringVector; } catch { base = null; }
  } else if (stale && opts?.wait) {
    try { base = (await computeAndSaveScoring(userId)) as unknown as ScoringVector; } catch { /* keep cached */ }
  } else if (stale && process.env.DEPLOY_TARGET !== "cloudflare") {
    recomputeScoringInBackground(userId);
  }
  if (!base) return empty;

  // Embed the user's direction live with bge-m3 and fill each pool row's trajDist
  // with a tiny (id, distance) query — the 1024-float vectors never leave
  // Postgres. bge BOTH sides: local ollama here, OpenRouter on CF (same space as
  // the pool's embedding_bge). This mirrors the get_ranking_inputs RPC, which the
  // Edge ranker drives off the stored profiles.direction_bge; here we override
  // with a FRESH embed of the current direction.
  const targetRole = (inputs.themes ?? []).find((a) => a?.kind === "target_role" && a.role && !a.pending)?.role ?? "";
  const aspireSents = (inputs.insights ?? [])
    .filter((r) => r.dimension === "aspiration" || r.dimension === "value")
    .slice(0, 3).map((r) => r.content ?? "").filter(Boolean);
  // bge is symmetric — plain text, no "search_query:" prefix (that was nomic).
  const directionText = [targetRole && `Target role: ${targetRole}.`, ...aspireSents].filter(Boolean).join(" ").trim();
  if (directionText && (inputs.pool ?? []).length) {
    try {
      const directionVec = (await embedBge([directionText]))[0];
      if (directionVec) {
        const lit = `[${directionVec.join(",")}]`;
        const ids = inputs.pool.map((p) => p.id);
        const distRes = await withScopedDb((d) =>
          d.execute(sql`SELECT id, (embedding_bge <=> ${lit}::vector)::float8 AS d FROM opportunities WHERE id = ANY(${pgArrayLit(ids)}::uuid[]) AND embedding_bge IS NOT NULL`),
        );
        const distMap = new Map(rows<{ id: string; d: number }>(distRes).map((r) => [r.id, r.d]));
        for (const p of inputs.pool) p.trajDist = distMap.get(p.id) ?? p.trajDist ?? null;
      }
    } catch { /* lexical trajectory fallback */ }
  }

  return rankFromInputs(inputs, base);
}

/**
 * Three roles that span the spectrum, to open the call with: one they clearly
 * fit, one that's a stretch (they'd want it but aren't fully qualified yet), and
 * one pivot (a genuinely different direction). Great "which pulls at you, and
 * why?" material.
 */
export function pickSpectrum(ranked: RankedJob[]): { kind: string; job: RankedJob }[] {
  if (!ranked.length) return [];
  const picks: { kind: string; job: RankedJob }[] = [];
  const used = new Set<string>();
  const take = (kind: string, job?: RankedJob) => {
    if (job && !used.has(job.id)) {
      picks.push({ kind, job });
      used.add(job.id);
    }
  };

  const top = ranked[0];
  take("Strong fit", top);
  const remain = () => ranked.filter((j) => !used.has(j.id));
  // a genuinely different life: the reasonably-ranked role whose shape (build vs
  // lead) is furthest from the top pick — the "would you rather build or lead?"
  const shapeDist = (j: RankedJob) =>
    Math.hypot(j.building - top.building, j.peopleLeadership - top.peopleLeadership);
  const contrast = remain()
    .filter((j) => j.fit > 0.45)
    .sort((a, b) => shapeDist(b) - shapeDist(a))[0];
  take("A different path", contrast);
  // a pivot: the most different domain
  const pivot = remain().sort((a, b) => b.novelty - a.novelty)[0];
  take("A pivot", pivot);

  return picks.slice(0, 3);
}

/** The 3-role spectrum flattened for the mentor prompt (empty if no jobs yet). */
export async function getCallSpectrum(
  userId: string,
): Promise<{ kind: string; title: string; company: string; why: string }[]> {
  const ranked = await rankMatches(userId);
  return pickSpectrum(ranked).map((s) => ({
    kind: s.kind,
    title: s.job.title ?? "a role",
    company: s.job.company ?? "",
    why: s.job.why,
  }));
}
