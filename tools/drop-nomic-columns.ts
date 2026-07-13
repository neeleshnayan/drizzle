/**
 * Deferred migration — drop the retired nomic columns now that trajectory is 100%
 * bge (embedding_bge / direction_bge). IRREVERSIBLE, so it first VERIFIES no DB
 * function still references them (the deployed get_ranking_inputs RPC was migrated
 * to bge), then drops. Idempotent (IF EXISTS).
 *
 *   npx tsx tools/drop-nomic-columns.ts
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

async function main() {
  loadEnvLocal();
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DIRECT_URL || process.env.DATABASE_URL!, { prepare: false, max: 1 });

  const targets = [
    { table: "opportunities", col: "embedding_vec" },
    { table: "opportunities", col: "embedding" },
    { table: "profiles", col: "direction_vec" },
  ];

  // 1) SAFETY: abort if any function body references a column we're about to drop.
  // (embedding_bge / direction_bge contain "embedding"/"direction" — match the
  //  exact dead names with word boundaries so we don't false-positive on _bge.)
  const fns = await sql<{ proname: string; def: string }[]>`
    SELECT proname, pg_get_functiondef(oid) AS def
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'`;
  const danger = /\bembedding_vec\b|\bdirection_vec\b|\bo\.embedding\b(?!_)/;
  const offenders = fns.filter((f) => danger.test(f.def)).map((f) => f.proname);
  if (offenders.length) {
    console.error(`ABORT — these functions still reference a nomic column: ${offenders.join(", ")}`);
    console.error("Migrate them (get_ranking_inputs should use embedding_bge / direction_bge) before dropping.");
    await sql.end();
    process.exit(1);
  }
  console.log("✓ safety: no DB function references embedding_vec / direction_vec / o.embedding");

  // 2) report which exist + how populated, then drop
  for (const t of targets) {
    const [exists] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = ${t.table} AND column_name = ${t.col}`;
    if (!exists.n) { console.log(`· ${t.table}.${t.col} — already gone`); continue; }
    await sql.unsafe(`ALTER TABLE ${t.table} DROP COLUMN IF EXISTS ${t.col}`);
    console.log(`✓ dropped ${t.table}.${t.col}`);
  }

  console.log("\nDONE — nomic columns retired. Trajectory is bge-only.");
  await sql.end();
  process.exit(0);
}
main().catch((e) => { console.error("drop-nomic-columns error:", e); process.exit(1); });
