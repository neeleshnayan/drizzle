/**
 * get_ranking_inputs(user, trusted[], direction) — EVERYTHING rankMatches needs,
 * in ONE round-trip, computed where the data lives (Supabase Postgres).
 *
 * Why: the ranking path fanned out ~12 sequential queries; from a Cloudflare
 * Worker each was an ocean round-trip to the DB region and the request often
 * blew past the Workers hang limit (the intermittent matches 500s). One RPC
 * call collapses the whole gather into a single hop; the validated blend math
 * stays in TypeScript.
 *
 * p_direction: the user's direction embedding as a pgvector literal ('[f,f,…]').
 * When present, the pool rows carry trajDist = cosine distance (embedding_bge
 * <=> direction) computed in-DB — the 1024-float bge vectors never leave
 * Postgres. (bge-m3 both sides now: the pool's embedding_bge + direction_bge.)
 *
 * Idempotent (CREATE OR REPLACE). SECURITY DEFINER + EXECUTE revoked from
 * anon/authenticated: only the service connection (the app) may call it.
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

const FN = `
-- the user's DIRECTION embedding (bge-m3, 1024d), maintained when a mentor call
-- sets/updates the target role. Lets the Edge ranker (which can reach OpenRouter
-- bge but not local nomic) compute semantic trajectory; Node overrides it with a
-- live bge embed. Same space as the pool's embedding_bge.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS direction_bge vector(1024);

CREATE OR REPLACE FUNCTION get_ranking_inputs(p_user uuid, p_trusted text[], p_direction text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
WITH me AS (
  SELECT id, scoring, scoring_stale, preferences, about_overrides,
         -- explicit p_direction (Node's live bge embed) wins; else the stored vector
         coalesce(p_direction::vector, direction_bge) AS dir
  FROM profiles WHERE user_id = p_user LIMIT 1
)
SELECT jsonb_build_object(
  'profile', (SELECT jsonb_build_object(
      'id', me.id,
      'scoring', me.scoring,
      'scoringStale', me.scoring_stale,
      'preferences', me.preferences,
      'aboutOverrides', me.about_overrides
    ) FROM me),
  'experiences', (SELECT coalesce(jsonb_agg(jsonb_build_object('startDate', e.start_date)), '[]'::jsonb)
    FROM experiences e WHERE e.profile_id = (SELECT id FROM me)),
  'education', (SELECT coalesce(jsonb_agg(jsonb_build_object('degree', ed.degree)), '[]'::jsonb)
    FROM education ed WHERE ed.profile_id = (SELECT id FROM me)),
  'certifications', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'issuer', c.issuer)), '[]'::jsonb)
    FROM certifications c WHERE c.profile_id = (SELECT id FROM me)),
  'skills', (SELECT coalesce(jsonb_agg(s.name), '[]'::jsonb)
    FROM skills s WHERE s.profile_id = (SELECT id FROM me)),
  'themes', (SELECT coalesce(jsonb_agg(t.latent_attributes), '[]'::jsonb)
    FROM resume_themes t WHERE t.profile_id = (SELECT id FROM me)),
  'insights', (SELECT coalesce(jsonb_agg(jsonb_build_object('dimension', i.dimension, 'content', i.content)), '[]'::jsonb)
    FROM (SELECT dimension, content FROM insights
          WHERE profile_id = (SELECT id FROM me) ORDER BY created_at DESC LIMIT 20) i),
  'signals', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', sg.kind, 'vector', sg.vector)), '[]'::jsonb)
    FROM (SELECT rs.kind, o.vector FROM ranking_signals rs
          JOIN opportunities o ON o.id = rs.opportunity_id
          WHERE rs.profile_id = (SELECT id FROM me)
          ORDER BY rs.created_at DESC LIMIT 200) sg),
  'dismissed', (SELECT coalesce(jsonb_agg(rs.opportunity_id), '[]'::jsonb)
    FROM ranking_signals rs
    WHERE rs.profile_id = (SELECT id FROM me) AND rs.kind = 'dismiss'),
  'pool', (SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
    FROM (SELECT o.id, o.title, o.company, o.location, o.remote,
                 o.comp_min AS "compMin", o.comp_max AS "compMax",
                 o.domain, o.url, o.source, o.vector, o.facts,
                 left(o.raw_text, 300) AS "rawText",
                 CASE WHEN (SELECT dir FROM me) IS NOT NULL AND o.embedding_bge IS NOT NULL
                      THEN (o.embedding_bge <=> (SELECT dir FROM me))::float8 END AS "trajDist"
          FROM opportunities o
          WHERE o.vectorized_at IS NOT NULL
            AND (o.vectorize_model = ANY(p_trusted) OR o.source = 'sample')
            AND (o.visibility = 'global' OR o.added_by_profile_id = (SELECT id FROM me))
          ORDER BY o.created_at DESC LIMIT 500) p)
)
$fn$;
REVOKE ALL ON FUNCTION get_ranking_inputs(uuid, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_ranking_inputs(uuid, text[], text) FROM anon;
REVOKE ALL ON FUNCTION get_ranking_inputs(uuid, text[], text) FROM authenticated;
GRANT EXECUTE ON FUNCTION get_ranking_inputs(uuid, text[], text) TO service_role;
`;

async function main() {
  loadEnvLocal();
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DIRECT_URL || process.env.DATABASE_URL!, { prepare: false, max: 1 });
  await sql.unsafe(FN);
  console.log("✓ get_ranking_inputs created");
  // smoke: run it for a real user and report shape + timing
  const t0 = Date.now();
  const [{ inputs }] = await sql<{ inputs: Record<string, unknown> }[]>`
    SELECT get_ranking_inputs((SELECT user_id FROM profiles ORDER BY created_at ASC LIMIT 1), ARRAY['gemma3:27b'], NULL) AS inputs`;
  const pool = (inputs.pool as unknown[]) ?? [];
  console.log(`✓ smoke: pool=${pool.length} skills=${(inputs.skills as unknown[])?.length} signals=${(inputs.signals as unknown[])?.length} in ${Date.now() - t0}ms`);
  await sql.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
