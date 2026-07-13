/**
 * FROZEN-FIXTURE regression harness — the safety net. Scores the shared PROFILES
 * against ~14 real roles whose {facts, vector, embedding} were snapshotted by
 * tools/pick-anchors.ts, then checks ROBUST RELATIVE assertions (gate thresholds,
 * fit/trajectory ordering) that encode "what a human expects and must never
 * silently break." Because the inputs are frozen, this tests RANKING LOGIC only —
 * it stays valid across the clean-slate re-crunch (refresh fixtures if a vector
 * materially changes; the assertions are the contract).
 *
 *   npx tsx tools/anchors.ts            # run all assertions
 *   npx tsx tools/anchors.ts --matrix   # also print the profile×role gate/fit/traj grid
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"].*$/g, "");
}
const SHOW_MATRIX = process.argv.includes("--matrix");

type Fixture = { key: string; why: string; id: string; title: string; company: string; facts: Record<string, unknown>; vector: Record<string, { score?: number }>; embedding: number[] | null };
type Rec = { gate: number; desire: number; evidence: number | null; trajectory: number | null; fit: number };

async function main() {
  const { scoreMatch } = await import("../src/lib/opportunities/match");
  const { blendCore, relevanceDamp } = await import("../src/lib/opportunities/blend");
  const { embedBge, cosine } = await import("../src/lib/embeddings");
  // use the PRODUCTION trajectory curve (bge-calibrated), not embeddings.ts's nomic one
  const { trajectoryFromCosine } = await import("../src/lib/opportunities/rank-core");
  const { PROFILES } = await import("./profiles");

  const fixtures = JSON.parse(readFileSync("tools/fixtures/anchors.json", "utf8")) as Fixture[];
  const byKey = new Map(fixtures.map((f) => [f.key, f]));
  const norm = (s: unknown) => String(s ?? "").toLowerCase().trim();
  const have = (mine: string[], s: string) => mine.some((m) => m === s || m.includes(s) || s.includes(m));

  // one bge embedding per profile direction — the SAME trajectory production uses
  // (bge symmetric → plain text, no "search_query:" prefix)
  const dirVecs = await embedBge(PROFILES.map((p) => p.direction));
  const dirByKey = new Map(PROFILES.map((p, i) => [p.key, dirVecs[i]]));

  // score every (profile, fixture) once
  const cell = new Map<string, Rec>();
  for (const p of PROFILES) {
    for (const f of fixtures) {
      const m = scoreMatch(p.vector as never, f.vector as never);
      const must = ((f.facts.must_have_skills as string[]) ?? []).map(norm);
      const nice = ((f.facts.nice_to_have_skills as string[]) ?? []).map(norm);
      const mustHit = must.length ? must.filter((s) => have(p.skills, s)).length / must.length : null;
      const niceHit = nice.length ? nice.filter((s) => have(p.skills, s)).length / nice.length : null;
      const evidence = mustHit === null && niceHit === null ? null : mustHit !== null ? 0.35 + 0.55 * mustHit + 0.1 * (niceHit ?? mustHit) : 0.5 + 0.5 * (niceHit as number);
      const emb = f.embedding;
      const trajectory = emb?.length ? trajectoryFromCosine(cosine(dirByKey.get(p.key)!, emb)) : null;
      const fit = m.gate * blendCore(m.desire, evidence, trajectory) * relevanceDamp(p.vector.seniority?.score ?? 0.5, evidence, trajectory);
      cell.set(`${p.key}|${f.key}`, { gate: m.gate, desire: m.desire, evidence, trajectory, fit });
    }
  }
  const get = (pk: string, fk: string): Rec => {
    const r = cell.get(`${pk}|${fk}`);
    if (!r) throw new Error(`no cell ${pk}|${fk}`);
    if (!byKey.has(fk)) throw new Error(`no fixture ${fk}`);
    return r;
  };

  // ---- ASSERTIONS: robust, relative, human-obvious. tough + simple mixed. ----
  type A = { label: string; run: () => { pass: boolean; got: string } };
  const gateLt = (pk: string, fk: string, x: number): A => ({ label: `${pk}: gate on ${fk} < ${x}`, run: () => { const g = get(pk, fk).gate; return { pass: g < x, got: `gate ${g.toFixed(2)}` }; } });
  const gateGt = (pk: string, fk: string, x: number): A => ({ label: `${pk}: gate on ${fk} > ${x}`, run: () => { const g = get(pk, fk).gate; return { pass: g > x, got: `gate ${g.toFixed(2)}` }; } });
  const fitGt = (pk: string, a: string, b: string): A => ({ label: `${pk}: fit ${a} > ${b}`, run: () => { const x = get(pk, a).fit, y = get(pk, b).fit; return { pass: x > y, got: `${x.toFixed(2)} vs ${y.toFixed(2)}` }; } });
  const trajGt = (pk: string, a: string, b: string): A => ({ label: `${pk}: trajectory ${a} > ${b}`, run: () => { const x = get(pk, a).trajectory, y = get(pk, b).trajectory; return { pass: x != null && y != null && x > y, got: `${x?.toFixed(2)} vs ${y?.toFixed(2)}` }; } });

  const ASSERTIONS: A[] = [
    // — discipline gates: a non-technical person CANNOT clear engineering —
    gateLt("sales_ae", "backend_ic", 0.15),
    gateLt("sales_ae", "newgrad_swe", 0.15), // THE regression: the bug that started this
    gateLt("sales_ae", "specialist", 0.15),
    gateLt("marketer", "backend_ic", 0.15),
    gateLt("marketer", "specialist", 0.2),
    gateLt("marketer", "newgrad_swe", 0.25),
    // — seniority gates: a junior CANNOT clear staff/director —
    gateLt("junior_analyst", "staff_ic", 0.2),
    gateLt("junior_analyst", "director", 0.15),
    gateLt("junior_analyst", "data_analyst", 0.3), // title-trap: this "Data Analyst" is STAFF-level
    // — over-qualification is NEVER penalized (gate only docks UNDER-qual). Use
    //   staff_ic (leadership 0.2, matches the profile) not backend_ic (whose
    //   req_leadership 0.4 legitimately docks a heads-down IC — that's a real
    //   minor gap, not an over-qual penalty). —
    gateGt("overqualified_staff", "newgrad_swe", 0.9),
    gateGt("overqualified_staff", "staff_ic", 0.9),
    // — positive clears that must never break —
    gateGt("senior_ic", "backend_ic", 0.5),
    gateGt("eng_manager", "eng_manager", 0.5),
    gateGt("eng_manager", "director", 0.4),
    // — fit ordering: the right discipline sits on top. Use staff_ic (both roles
    //   gate ~0.95 for a senior eng, so the discipline SIGNAL decides, not a gate
    //   gap). backend_ic vs sales is confounded by backend's noisy req_leadership. —
    fitGt("senior_ic", "staff_ic", "sales_ae"),
    fitGt("senior_ic", "backend_ic", "recruiter_ops"),
    fitGt("sales_ae", "sales_ae", "backend_ic"),
    fitGt("marketer", "marketing", "backend_ic"),
    fitGt("junior_analyst", "media_social", "staff_ic"),
    // — trajectory (embedding) points the right way —
    trajGt("senior_ic", "backend_ic", "sales_ae"),
    trajGt("marketer", "marketing", "backend_ic"),
    trajGt("sales_ae", "sales_ae", "specialist"),
    trajGt("eng_manager", "eng_manager", "sales_ae"),
    // — career-changer tension: WANTS pm (trajectory) but gate says not-yet —
    gateLt("career_changer", "product_manager", 0.3),
    trajGt("career_changer", "product_manager", "sales_ae"),
  ];

  if (SHOW_MATRIX) {
    console.log(`\ngate matrix (rows=profiles, cols=fixtures):`);
    const cols = fixtures.map((f) => f.key.slice(0, 6).padStart(6));
    console.log(`${"".padEnd(20)} ${cols.join(" ")}`);
    for (const p of PROFILES) {
      const row = fixtures.map((f) => get(p.key, f.key).gate.toFixed(2).padStart(6)).join(" ");
      console.log(`${p.key.padEnd(20)} ${row}`);
    }
  }

  console.log(`\nrunning ${ASSERTIONS.length} anchor assertions against ${fixtures.length} frozen roles\n${"=".repeat(64)}`);
  let fail = 0;
  for (const a of ASSERTIONS) {
    const r = a.run();
    if (!r.pass) fail++;
    console.log(`  ${r.pass ? "✅" : "❌"} ${a.label.padEnd(46)} ${r.got}`);
  }
  console.log(`${"=".repeat(64)}\n${fail === 0 ? `✅ ALL ${ASSERTIONS.length} ANCHORS HOLD` : `❌ ${fail}/${ASSERTIONS.length} ANCHORS BROKEN`}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
