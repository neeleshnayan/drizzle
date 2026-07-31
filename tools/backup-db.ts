/**
 * Full logical backup of the Supabase Postgres → local JSON, no pg_dump needed.
 * Dumps every public table (all rows, incl. jsonb + pgvector columns as text) to
 * Documents/jolly-backups/<timestamp>/<table>.json + a manifest.json with counts.
 * Restore-friendly: each file is an array of row objects. Run whenever, and
 * ALWAYS before the project risks pausing.
 *
 *   npx tsx tools/backup-db.ts
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL!;
  const sql = postgres(url, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 15 });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(homedir(), "Documents", "jolly-backups", stamp);
  mkdirSync(dir, { recursive: true });

  try {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
    console.log(`Backing up ${tables.length} tables → ${dir}\n`);
    const manifest: Record<string, number> = {};
    let total = 0;
    for (const t of tables) {
      const rows = await sql.unsafe(`SELECT * FROM "${t.table_name}"`);
      writeFileSync(join(dir, `${t.table_name}.json`), JSON.stringify(rows, null, 0));
      manifest[t.table_name] = rows.length;
      total += rows.length;
      console.log(`  ✓ ${t.table_name.padEnd(26)} ${rows.length} rows`);
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ takenAt: new Date().toISOString(), project: url.match(/postgres\.([a-z0-9]+)/)?.[1] ?? "?", tables: manifest, totalRows: total }, null, 2));
    console.log(`\n✅ BACKUP COMPLETE — ${total} rows across ${tables.length} tables`);
    console.log(`   ${dir}`);
  } catch (e) {
    console.error(`\n✗ backup failed: ${(e as Error).message}`);
    if (/tenant|not found|ENOTFOUND/i.test((e as Error).message)) {
      console.error("  → the project appears PAUSED. Restore it in the Supabase dashboard, then re-run.");
    }
    await sql.end();
    process.exit(1);
  }
  await sql.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
