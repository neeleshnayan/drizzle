/**
 * Mentor-direction rec sanity — the troubleshooting net for the LIVE mentor recs.
 * When a user says "I want to explore marketing" mid-call, recsForDirection embeds
 * that direction with bge and pulls the nearest roles from the pool. This harness
 * asserts, per direction, that the top roles LOOK like that family and carry NO
 * red-flag roles from an unrelated family. Run after any embed/pool change.
 *
 *   npx tsx tools/mentor-recs-sanity.ts
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
delete process.env.EMBED_PROVIDER;   // force LOCAL ollama bge (mirror not required — same model as CF)
delete process.env.DEPLOY_TARGET;

// any uuid — the bge nearest-neighbour path doesn't use the user (it's a pure
// direction→pool pull); the arg only exists for the keyword fallback.
const ANY_USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Check = { dir: string; expect: RegExp; redFlag: RegExp };
const CHECKS: Check[] = [
  { dir: "marketing", expect: /market|brand|growth|content|demand|communications|social|community/i, redFlag: /software engineer|backend|research engineer|data scientist|nurse|physician|accountant/i },
  { dir: "data science", expect: /data scien|machine learning|\bml\b|\bai\b|analyt|analyst|research/i, redFlag: /account executive|sales|recruiter|nurse|designer|marketing manager/i },
  { dir: "product management", expect: /product manager|product owner|product lead|head of product|\bpm\b|product/i, redFlag: /software engineer|backend|nurse|accountant|sales development/i },
  { dir: "sales", expect: /sales|account executive|account manager|business develop|revenue|partnership|customer success/i, redFlag: /software engineer|data scientist|nurse|designer|research/i },
  { dir: "finance", expect: /financ|account|audit|invest|equity|treasury|quant|\brisk\b|controller/i, redFlag: /software engineer|designer|nurse|marketing manager/i },
  { dir: "software engineering", expect: /engineer|software|developer|backend|frontend|platform|infra|\bsre\b/i, redFlag: /sales|marketing manager|recruiter|account executive/i },
];

async function main() {
  const { recsForDirection } = await import("@/lib/opportunities/direction");
  let failed = 0;
  for (const c of CHECKS) {
    let roles: { title: string; company: string }[] = [];
    try { roles = await recsForDirection(ANY_USER, c.dir); } catch (e) { console.log(`✗ ${c.dir}: ERROR ${(e as Error).message}`); failed++; continue; }
    const top = roles.slice(0, 4);
    const hits = top.filter((r) => c.expect.test(r.title)).length;
    const flags = top.filter((r) => c.redFlag.test(r.title));
    const ok = hits >= Math.min(3, top.length) && flags.length === 0 && top.length > 0;
    if (!ok) failed++;
    console.log(`${ok ? "OK  " : "FAIL"}  ${c.dir.toUpperCase()} — ${hits}/${top.length} on-family, ${flags.length} red-flag`);
    for (const r of top) console.log(`        ${c.expect.test(r.title) ? "·" : c.redFlag.test(r.title) ? "✗" : " "} ${r.title} @ ${r.company}`);
    if (flags.length) console.log(`        RED-FLAGS: ${flags.map((f) => f.title).join(", ")}`);
  }
  console.log(failed ? `\n${failed} DIRECTION(S) FAILED` : "\nALL DIRECTIONS PASS");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("mentor-recs-sanity error:", e); process.exit(1); });
