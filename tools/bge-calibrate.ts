/**
 * bge trajectory calibration. For a spread of career directions, embed each with
 * bge-m3 (local ollama) and measure the cosine distribution against the pool's
 * embedding_bge (computed IN Postgres via pgvector). Prints the pooled
 * percentiles → proposed [COS_LO, COS_HI] for trajectoryFromCosine, plus each
 * direction's top-10 cosines so we can SEE whether the leaders are bunched
 * (the compression the linear curve would flatten).
 *
 *   npx tsx tools/bge-calibrate.ts
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
// force the LOCAL ollama bge path (not OpenRouter) for calibration
delete process.env.EMBED_PROVIDER;
delete process.env.DEPLOY_TARGET;

const DIRECTIONS = [
  "marketing", "data science", "product management", "software engineering",
  "sales", "design", "finance", "operations", "consulting", "founding a startup",
];

async function main() {
  const { db } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  const { embedBge } = await import("@/lib/embeddings");

  const rows = <T>(res: unknown): T[] => (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as T[];
  const pct = (arr: number[], p: number) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };

  const allTop: number[] = [];   // top-10 cosines across directions (the "leaders")
  const allP: Record<string, number[]> = { p25: [], p50: [], p75: [], p90: [], p95: [], p99: [], max: [] };

  for (const d of DIRECTIONS) {
    const [vec] = await embedBge([d]);
    if (!vec?.length) { console.log(`  ${d}: no vector (ollama bge-m3 unreachable?)`); continue; }
    const lit = `[${vec.join(",")}]`;
    const res = await db.execute(sql`
      SELECT percentile_cont(ARRAY[0.25,0.5,0.75,0.9,0.95,0.99]) WITHIN GROUP (ORDER BY 1 - (embedding_bge <=> ${lit}::vector)) AS ps,
             max(1 - (embedding_bge <=> ${lit}::vector)) AS mx
      FROM opportunities WHERE embedding_bge IS NOT NULL AND visibility = 'global'
    `);
    const r = rows<{ ps: number[]; mx: number }>(res)[0];
    const [p25, p50, p75, p90, p95, p99] = r.ps.map(Number);
    allP.p25.push(p25); allP.p50.push(p50); allP.p75.push(p75); allP.p90.push(p90); allP.p95.push(p95); allP.p99.push(p99); allP.max.push(Number(r.mx));

    const topRes = await db.execute(sql`
      SELECT 1 - (embedding_bge <=> ${lit}::vector) AS cos, title
      FROM opportunities WHERE embedding_bge IS NOT NULL AND visibility = 'global'
      ORDER BY embedding_bge <=> ${lit}::vector LIMIT 10
    `);
    const top = rows<{ cos: number; title: string }>(topRes);
    allTop.push(...top.map((t) => Number(t.cos)));
    console.log(`\n${d.toUpperCase()}  p50=${p50.toFixed(3)} p90=${p90.toFixed(3)} p99=${p99.toFixed(3)} max=${Number(r.mx).toFixed(3)}`);
    console.log("  top10: " + top.map((t) => Number(t.cos).toFixed(3)).join(" "));
  }

  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  console.log("\n================ POOLED (avg across directions) ================");
  for (const k of Object.keys(allP)) console.log(`  ${k}: ${avg(allP[k]).toFixed(3)}`);
  console.log(`\n  top-10 leaders: min=${Math.min(...allTop).toFixed(3)} median=${pct(allTop, 0.5).toFixed(3)} max=${Math.max(...allTop).toFixed(3)}`);
  console.log("\nPROPOSAL: COS_LO ≈ p50 (off-direction floor), COS_HI ≈ p99 (only true tops saturate).");
  console.log(`  → COS_LO=${avg(allP.p50).toFixed(2)}  COS_HI=${avg(allP.p99).toFixed(2)}`);
  process.exit(0);
}
main().catch((e) => { console.error("bge-calibrate error:", e); process.exit(1); });
