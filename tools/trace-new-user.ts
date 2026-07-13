/**
 * LIVE new-user trace — drives the REAL first-run pipeline in-process for the
 * fixed test user and prints every step + the actual agent_runs (agent, model,
 * tokens, cost, ms) it produced. Runs on local ollama (free), so cost is $0
 * here; the same agents bill OpenRouter on CF. Verifies the whole flow end to
 * end and shows exactly where the LLM calls land.
 *
 *   npx tsx tools/trace-new-user.ts
 */
import { readFileSync } from "node:fs";
function loadEnvLocal() {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') || v.startsWith("'")) { const q = v[0]; const e = v.indexOf(q, 1); v = e > 0 ? v.slice(1, e) : v.slice(1); }
    else { const h = v.indexOf(" #"); if (h >= 0) v = v.slice(0, h).trim(); }
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnvLocal();
delete process.env.DEPLOY_TARGET; // local Node path (ollama), not CF

const RESUME = `NEHA SHARMA
Bengaluru, India | neha.sharma@example.com | +91 98765 43210

SUMMARY
Product analyst with 4 years turning messy data into decisions at fast-growing
consumer fintech. I like owning a metric end to end and shipping the dashboard
that moves it.

EXPERIENCE
Senior Data Analyst — Groww (Jun 2022 - Present)
- Built the activation funnel model that lifted D7 retention 12%.
- Owned the growth analytics stack (SQL, dbt, Looker); partnered with 3 PMs.
- Ran A/B tests on onboarding; presented weekly to the leadership team.

Data Analyst — Razorpay (Jul 2020 - May 2022)
- Automated merchant-risk reporting, cutting manual review time 40%.
- Shipped the first self-serve metrics layer for the payments team.

EDUCATION
B.Tech, Computer Science — VIT Vellore (2016 - 2020)

SKILLS
SQL, Python, dbt, Looker, A/B testing, product analytics, stakeholder management`;

function fmt(ms: number) { return `${(ms / 1000).toFixed(1)}s`; }

async function main() {
  const { db } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  const { profiles } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const { TEST_USER_ID, TEST_USER_EMAIL, TEST_USER_NAME } = await import("@/lib/dev/test-user");
  const { parseResumeFile } = await import("@/lib/extraction/parse");
  const { ensureProfile } = await import("@/lib/profile/ensure");
  const { runAgent } = await import("@/agents/run");
  const { resumeExtractor } = await import("@/agents/resume-extractor");
  const { persistExtraction } = await import("@/lib/profile/persist");
  const { ensureStarterThemes } = await import("@/lib/track/persist");
  const { computeAndSaveScoring, getSavedScoring } = await import("@/lib/scoring/persist");
  const { rankMatchesWithMeta } = await import("@/lib/opportunities/recommend");
  const rows = <T>(r: unknown): T[] => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as T[];

  const uid = TEST_USER_ID;
  const traceStart = new Date().toISOString(); // scope the ledger to THIS run
  const line = (s: string) => console.log(s);
  const step = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    const out = await fn();
    line(`  ${label.padEnd(46)} ${fmt(Date.now() - t0)}`);
    return out;
  };

  line(`\n══ LIVE NEW-USER TRACE (test user ${uid.slice(0, 8)}…, local ollama) ══\n`);

  // 0. reset — brand-new user, no data
  await step("0. reset test user (flush + bare profile)", async () => {
    await db.delete(profiles).where(eq(profiles.userId, uid));
    await db.insert(profiles).values({ userId: uid, fullName: TEST_USER_NAME, email: TEST_USER_EMAIL });
  });

  // 1. first dashboard BEFORE résumé → matches should be empty, NO scoring compute
  const before = await step("1. /matches with no résumé (empty-profile gate)", async () => {
    const s = await getSavedScoring(uid);
    const r = await rankMatchesWithMeta(uid);
    return { scoring: s.scoring, count: r.matches.length };
  });
  line(`       → ${before.count} matches, scoring=${before.scoring ? "set" : "null"} (expect 0 / null — no LLM spent)`);

  // 2. upload résumé → parse (no LLM)
  const rawText = await step("2. parse résumé (.txt, unpdf path skipped)", async () =>
    parseResumeFile(Buffer.from(RESUME, "utf8"), "text/plain", "resume.txt"),
  );
  line(`       → ${rawText.length} chars extracted`);

  // 3. extraction agent (LLM)  4. persist  5. starter themes
  const profileId = await ensureProfile(uid);
  const { output: extraction } = await step("3. resume_extractor agent  [LLM]", async () =>
    runAgent(resumeExtractor, { rawText, images: [] }, { userId: uid, profileId }),
  );
  await step("4. persist extraction (experiences/skills/…)", async () =>
    persistExtraction({ userId: uid, extraction, rawText, storagePath: undefined }),
  );
  await step("5. seed starter themes (Default + TBD target)", async () => ensureStarterThemes(uid));

  // 6. scoring vector (LLM)
  await step("6. profile_scorer agent  [LLM]", async () => computeAndSaveScoring(uid));

  // 7. dashboard AFTER résumé → matches (ranking: local bge direction embed + blend)
  const after = await step("7. /matches with résumé (rank: bge + blend)", async () => rankMatchesWithMeta(uid));
  line(`       → ${after.matches.length} matches, learning=${after.learning.active}`);
  line(`\n  TOP 3 MATCHES:`);
  after.matches.slice(0, 3).forEach((m) => line(`    ${Math.round(m.fit * 100)}%  ${m.title} @ ${m.company}`));

  // 8. the agent_runs this flow produced — the real cost ledger
  line(`\n  AGENT RUNS logged (the $ ledger — local ollama = $0; CF bills OpenRouter):`);
  // scope to THIS run's profile row (created fresh at reset) so we don't pull in
  // historical runs matched by meta.userId from earlier sessions
  const runs = rows<{ agent: string; model: string | null; input_tokens: number | null; output_tokens: number | null; cost_usd: string | null; duration_ms: number | null }>(
    await db.execute(sql`
      SELECT ar.agent, ar.model, ar.input_tokens, ar.output_tokens, ar.cost_usd, ar.duration_ms
      FROM agent_runs ar
      WHERE ar.meta->>'userId' = ${uid} AND ar.created_at >= ${traceStart}
      ORDER BY ar.created_at ASC`),
  );
  for (const r of runs) {
    line(`    · ${r.agent.padEnd(20)} ${(r.model ?? "?").padEnd(24)} in=${r.input_tokens ?? "?"} out=${r.output_tokens ?? "?"} $${Number(r.cost_usd ?? 0).toFixed(4)} ${fmt(r.duration_ms ?? 0)}`);
  }
  line(`\n  ${runs.length} LLM call(s) for a full first-run journey.\n`);
  process.exit(0);
}
main().catch((e) => { console.error("trace error:", e); process.exit(1); });
