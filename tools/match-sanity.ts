/**
 * END-TO-END ranking sanity: do archetype profiles get the matches a human would
 * expect, scored against the LIVE crunched pool? The candidate profiles (vector +
 * skills + direction) come from the shared tools/profiles.ts, and the blend from
 * src/lib/opportunities/blend.ts — the SAME seams production and tools/anchors.ts
 * use, so a weight change moves all three together. Each check declares what its
 * top-10 SHOULD look like (expect pattern) and what must NOT rank high (red flag).
 * This is the acceptance test on real data; tools/anchors.ts is the frozen-input
 * regression guard. Run both after any scoring/prompt change.
 *
 *   npx tsx tools/match-sanity.ts            # summary + per-archetype detail
 *   npx tsx tools/match-sanity.ts --top=15   # widen the inspection window
 */
import { readFileSync } from "node:fs";
function loadEnvLocal() {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
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

const TOP = Number(process.argv.find((a) => a.startsWith("--top="))?.split("=")[1] ?? 10);

// The two commercial archetypes (sales AE, product marketer) test the SAME
// acceptance criterion: commercial/GTM roles cluster on top, zero technical or
// legal garbage. They do NOT test fine sales-vs-marketing separation — the blend
// weights desire highest, and sales & marketing share a near-identical desire
// profile (low tech, high people, comp-driven), so trajectory can only nudge
// order within the GTM family, not split it. So both count the whole GTM family
// as "expected"; the strict per-archetype redFlag is what actually gates junk.
const GTM_EXPECT =
  /sales|account executive|account manager|business development|\bgtm\b|revenue|partnerships?|partner development|marketing|\bbrand\b|content|community|communications|growth|customer success|solutions consultant|\bmedia\b/i;

// Pool-scan assertions per archetype. The candidate itself (vector/skills/
// direction) lives in profiles.ts and is joined by `key`; here we only declare
// what the RANKING against the live pool should look like.
type Check = {
  key: string; // → profiles.ts
  target: string[]; // lexical trajectory fallback (only used for rows with no embedding)
  expect: RegExp; // top-10 titles should mostly look like this
  redFlag: RegExp; // these in the top-5 = ranking is broken
  atLevel?: (roleVec: Record<string, { score?: number }>) => boolean;
  // Fluid profiles (juniors) SHOULD get breadth — a junior can become many
  // things, so a diverse top-10 is correct, not a bug. For these we don't demand
  // coverage; we assert the skill-relevant role LEADS + no senior leak, i.e. the
  // relevance damp tilted the breadth toward what they've invested in.
  breadthOK?: boolean;
  note: string;
};

const CHECKS: Check[] = [
  {
    key: "senior_ic",
    target: ["engineer", "backend", "infrastructure", "platform"],
    expect: /engineer|infra|platform|backend|software|systems|sre|devops|data/i,
    redFlag: /account executive|sales|marketing|counsel|attorney|recruiter|people ops|customer success/i,
    note: "should see IC engineering roles, not GTM",
  },
  {
    key: "eng_manager",
    target: ["engineering", "manager", "team", "lead"],
    expect: /manager|lead|head|director|vp/i,
    redFlag: /account executive|counsel|attorney|paralegal/i,
    note: "leadership roles should outrank pure-IC roles",
  },
  {
    key: "sales_ae",
    target: ["sales", "account", "enterprise", "revenue"],
    expect: GTM_EXPECT,
    // DEEP engineering only — titles like Vercel's "Media Engineer, Social" are
    // content roles the vectors correctly read as GTM-adjacent, not engineering
    redFlag: /software engineer|infrastructure|backend|staff|sre\b|research engineer|scientist|counsel/i,
    note: "GTM roles on top, zero deep engineering in top-5",
  },
  {
    key: "marketer",
    target: ["marketing", "brand", "content", "growth"],
    expect: GTM_EXPECT,
    redFlag: /software engineer|infrastructure|backend|staff|sre\b|research engineer|counsel|attorney|scientist/i,
    note: "marketing/brand/content on top",
  },
  {
    key: "junior_analyst",
    target: ["analyst", "data", "insights"],
    expect: /analyst|data|insights|bi\b|analytics|associate|junior|coordinator/i,
    redFlag: /staff|principal|director|head of|vp|chief|senior manager|\blead\b/i,
    // a "Data Scientist" title says nothing about level — count it as available
    // for a junior only if the JD itself asks junior-to-mid seniority
    atLevel: (v) => (v.req_seniority?.score ?? 1) <= 0.55,
    breadthOK: true,
    note: "breadth is right for a junior — skill-relevant role must LEAD, no senior leak",
  },
];

async function main() {
  const { db } = await import("../src/db");
  const { sql } = await import("drizzle-orm");
  const { scoreMatch } = await import("../src/lib/opportunities/match");
  const { blendCore, relevanceDamp } = await import("../src/lib/opportunities/blend");
  const { STRONG_MODEL } = await import("../src/lib/jobs/vectorize");
  const { embedBge, cosine } = await import("../src/lib/embeddings");
  // production trajectory curve (bge-calibrated) — the SAME one ranking uses
  const { trajectoryFromCosine } = await import("../src/lib/opportunities/rank-core");
  const { profileByKey } = await import("./profiles");

  const profiles = CHECKS.map((c) => profileByKey(c.key));

  // bge lives in a raw column (not the drizzle schema), so fetch it as text and
  // parse — the pgvector text form ('[f,f,…]') is already valid JSON.
  const rawRows = await db.execute(sql`
    SELECT title, company, vector, facts, embedding_bge::text AS emb
    FROM opportunities
    WHERE vectorize_model = ${STRONG_MODEL} AND vector IS NOT NULL AND source <> 'sample'`);
  const rows = ((Array.isArray(rawRows) ? rawRows : (rawRows as { rows: unknown[] }).rows) as {
    title: string | null; company: string | null; vector: unknown; facts: unknown; emb: string | null;
  }[]).map((r) => ({ title: r.title, company: r.company, vector: r.vector, facts: r.facts, embedding: r.emb ? (JSON.parse(r.emb) as number[]) : null }));

  // embed the directions once with bge — the SAME trajectory production uses
  // (bge symmetric → plain text, no "search_query:" prefix)
  const dirVecs = await embedBge(profiles.map((p) => p.direction));

  console.log(`Scoring against ${rows.length} ${STRONG_MODEL}-vectorized roles\n${"=".repeat(72)}`);
  if (rows.length < 15) console.log("⚠ small pool — directional only; re-run as the backfill fills in\n");

  const norm = (s: unknown) => String(s ?? "").toLowerCase().trim();
  const have = (mine: string[], s: string) => mine.some((m) => m === s || m.includes(s) || s.includes(m));

  let failures = 0;
  CHECKS.forEach((a, ai) => {
    const prof = profiles[ai];
    const dvec = dirVecs[ai];
    const scored = rows
      .map((r) => {
        const v = r.vector as never;
        const f = (r.facts ?? {}) as { must_have_skills?: string[]; nice_to_have_skills?: string[]; summary?: string; domain?: string };
        const m = scoreMatch(prof.vector as never, v);
        const must = (f.must_have_skills ?? []).map(norm);
        const nice = (f.nice_to_have_skills ?? []).map(norm);
        const mustHit = must.length ? must.filter((s) => have(prof.skills, s)).length / must.length : null;
        const niceHit = nice.length ? nice.filter((s) => have(prof.skills, s)).length / nice.length : null;
        const evidence = mustHit === null && niceHit === null ? null : mustHit !== null ? 0.35 + 0.55 * mustHit + 0.1 * (niceHit ?? mustHit) : 0.5 + 0.5 * (niceHit as number);
        // trajectory: embedding cosine (production path); lexical fallback for
        // any row missing an embedding
        const roleText = ` ${norm(r.title)} ${norm(f.domain)} ${norm(f.summary)} ${must.join(" ")} `;
        const emb = r.embedding as number[] | null;
        const trajectory = emb?.length
          ? trajectoryFromCosine(cosine(dvec, emb))
          : 0.5 + 0.5 * (a.target.filter((w) => roleText.includes(w)).length / a.target.length);
        const fit = m.gate * blendCore(m.desire, evidence, trajectory) * relevanceDamp(prof.vector.seniority?.score ?? 0.5, evidence, trajectory);
        return { title: r.title ?? "?", company: r.company ?? "?", fit, desire: m.desire, gate: m.gate, evidence, vec: r.vector as Record<string, { score?: number }> };
      })
      .sort((x, y) => y.fit - x.fit);

    const top = scored.slice(0, TOP);
    // a title is "expected" only if it matches the expect pattern AND isn't a
    // red flag (kills regex false-positives like "Lead DATA Scientist" reading
    // as junior-analyst material, or "GROWTH Platform" eng reading as marketing)
    const isExpected = (t: { title: string; vec: Record<string, { score?: number }> }) =>
      a.expect.test(t.title) && !a.redFlag.test(t.title) && (a.atLevel ? a.atLevel(t.vec) : true);
    const expectHits = top.filter(isExpected).length;
    // a red flag is fatal only when scored like a real recommendation (≥45%) —
    // a wrong-domain role the system already sank to 25% is CORRECT behavior,
    // it just has nothing better to sit above in a mid-backfill pool
    const redInTop5 = scored.slice(0, 5).filter((t) => a.redFlag.test(t.title) && t.fit >= 0.45);
    const spread = scored.length > 1 ? scored[0].fit - scored[scored.length - 1].fit : 0;
    // availability-aware: judge the RANKING on what exists, not the inventory.
    // Zero relevant roles in the pool → only the red-flag check applies.
    const available = scored.filter(isExpected).length;
    const required = available === 0 ? 0 : Math.min(Math.ceil(TOP * 0.6), Math.max(1, Math.floor(available * 0.8)));
    // breadthOK archetypes: the #1 role must be skill-relevant (an expected role
    // led the list) + no senior leak — coverage isn't required, breadth is fine.
    const leadRelevant = top.length > 0 && isExpected(top[0]);
    const pass = a.breadthOK
      ? leadRelevant && redInTop5.length === 0
      : expectHits >= required && redInTop5.length === 0;
    if (!pass) failures++;

    console.log(`\n■ ${prof.name} — ${a.note}`);
    if (a.breadthOK)
      console.log(`  ${pass ? "✅ PASS" : "❌ FAIL"}: lead ${leadRelevant ? "IS" : "NOT"} skill-relevant (${top[0]?.title?.slice(0, 32)}), ${redInTop5.length} red-flag ≥45% in top-5, breadth OK, fit spread ${spread.toFixed(2)}`);
    else
      console.log(`  ${pass ? "✅ PASS" : "❌ FAIL"}: ${expectHits}/${TOP} expected-looking in top-${TOP} (${available} exist in pool, needed ≥${required}), ${redInTop5.length} red-flag ≥45% in top-5, fit spread ${spread.toFixed(2)}`);
    if (redInTop5.length) console.log(`  red flags: ${redInTop5.map((t) => t.title).join(" · ")}`);
    for (const t of top) {
      const mark = a.redFlag.test(t.title) ? "🚩" : a.expect.test(t.title) ? "  " : "· ";
      console.log(`   ${mark}${(t.fit * 100).toFixed(0).padStart(3)}%  ${t.title}  @ ${t.company}   (desire ${t.desire.toFixed(2)} gate ${t.gate.toFixed(2)}${t.evidence !== null ? ` ev ${t.evidence?.toFixed(2)}` : ""})`);
    }
    console.log(`   … bottom 3:`);
    for (const t of scored.slice(-3)) console.log(`     ${(t.fit * 100).toFixed(0).padStart(3)}%  ${t.title}  @ ${t.company}`);
  });

  console.log(`\n${"=".repeat(72)}\n${failures === 0 ? "✅ ALL ARCHETYPES PASS" : `❌ ${failures}/${CHECKS.length} archetypes FAIL`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
