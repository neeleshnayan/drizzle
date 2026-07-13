/**
 * direction_bge sweep — the ingestion-box job that gives the Cloudflare Edge
 * ranker SEMANTIC trajectory. For every profile with an agreed target role, build
 * the direction text (target + aspiration/value insights), embed it with bge-m3,
 * and store it in profiles.direction_bge (1024d, same space as the pool's
 * embedding_bge). The Edge ranker reads that vector and computes trajectory
 * in-DB. Idempotent; run after crunches / mentor calls. See
 * docs/adr-001-ranking-funnel.md + the CF ranking memory.
 *
 *   npx tsx tools/direction-vec-sweep.ts            # all profiles with a target
 *   npx tsx tools/direction-vec-sweep.ts --user <uuid>   # one user
 */
import { readFileSync } from "node:fs";
import { embedBge } from "@/lib/embeddings";

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
  const onlyUser = process.argv.includes("--user") ? process.argv[process.argv.indexOf("--user") + 1] : null;
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DIRECT_URL || process.env.DATABASE_URL!, { prepare: false, max: 2 });

  const profiles = await sql<{ id: string; userId: string }[]>`
    SELECT id, user_id AS "userId" FROM profiles
    ${onlyUser ? sql`WHERE user_id = ${onlyUser}::uuid` : sql``}
    ORDER BY created_at ASC`;
  console.log(`scanning ${profiles.length} profile(s)…`);

  let set = 0, skipped = 0;
  for (const p of profiles) {
    // agreed target role (non-pending) from the résumé themes
    const themes = await sql<{ la: unknown }[]>`
      SELECT latent_attributes AS la FROM resume_themes WHERE profile_id = ${p.id}`;
    const target = themes
      .map((t) => t.la as { kind?: string; role?: string; pending?: boolean } | null)
      .find((a) => a?.kind === "target_role" && a.role && !a.pending)?.role ?? "";
    // latest aspiration / value insights
    const ins = await sql<{ content: string | null }[]>`
      SELECT content FROM insights
      WHERE profile_id = ${p.id} AND dimension IN ('aspiration','value')
      ORDER BY created_at DESC LIMIT 3`;
    const aspireSents = ins.map((r) => r.content ?? "").filter(Boolean);

    // bge is symmetric — plain text, no "search_query:" prefix (that was nomic)
    const text = [target && `Target role: ${target}.`, ...aspireSents].filter(Boolean).join(" ").trim();
    if (!text) { skipped++; continue; }
    try {
      const vec = (await embedBge([text]))[0];
      if (!vec?.length) { skipped++; continue; }
      await sql`UPDATE profiles SET direction_bge = ${`[${vec.join(",")}]`}::vector WHERE id = ${p.id}`;
      set++;
      console.log(`  ✓ ${p.userId.slice(0, 8)}… → "${target || aspireSents[0]?.slice(0, 40)}"`);
    } catch (e) {
      skipped++;
      console.log(`  ✗ ${p.userId.slice(0, 8)}…: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  console.log(`\nDONE — ${set} direction vectors written, ${skipped} skipped (no target/aspiration yet).`);
  await sql.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
