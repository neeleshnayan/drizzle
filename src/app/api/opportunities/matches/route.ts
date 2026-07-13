/**
 * GET /api/opportunities/matches?u=<userId> — roles ranked for this user, with a
 * per-role "why", plus a 3-role spectrum to open a mentor call with. Serves the
 * cached scoring vector, so it's cheap to poll. If the vector is stale (edited
 * since), the recompute runs in the BACKGROUND and this returns the cached
 * ranking instantly — reads never block on the big-model pass. Pass ?refresh=1
 * (the explicit Refresh button) to wait for the fresh ranking.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveUserId } from "@/lib/auth/user";
import { getSavedScoring, computeAndSaveScoring, recomputeScoringInBackground } from "@/lib/scoring/persist";
import { rankMatchesWithMeta, rankViaEdge, pickSpectrum, type RankedJob } from "@/lib/opportunities/recommend";
import { canonSkillKey } from "@/lib/skills/canon";
import { getLearnedSkillCasing, displaySkillSmart } from "@/lib/skills/learned";

export const runtime = "nodejs";
export const maxDuration = 90;

/** `key` is the canonical lowercase identity (matching/filtering); `skill` is
 *  the résumé-ready display form. Never show the key; never match the label. */
export type SkillRadarEntry = { key: string; skill: string; demand: number; have: boolean; avgFit: number };

/** The skills-overlap lens: across the roles that ALIGN with this user, which
 *  skills does the market keep asking for — and which are missing from their
 *  résumé? Demand-ranked, so a missing skill becomes an actionable ("18 of
 *  your aligned roles want Kubernetes"), not a vague to-do. Aggregated by
 *  CANONICAL key so "TypeScript"/"typescript"/"ts" from different extraction
 *  models tally as one skill, displayed in résumé casing. */
function skillRadar(matches: RankedJob[], userSkills: string[], learned: Map<string, string>): SkillRadarEntry[] {
  const mine = userSkills.map(canonSkillKey).filter(Boolean);
  const haveSkill = (s: string) => mine.some((m) => m === s || m.includes(s) || s.includes(m));
  const tally = new Map<string, { demand: number; fitSum: number }>();
  for (const m of matches.slice(0, 60)) {
    // a role may list casing/alias variants of one skill; count each key once per role
    const keys = new Set(m.skills.map(canonSkillKey).filter((k) => k.length >= 2 && k.length <= 40));
    for (const k of keys) {
      const t = tally.get(k) ?? { demand: 0, fitSum: 0 };
      t.demand += 1;
      t.fitSum += m.fit;
      tally.set(k, t);
    }
  }
  return [...tally.entries()]
    .filter(([, t]) => t.demand >= 2) // one-off mentions aren't a signal
    .map(([key, t]) => ({ key, skill: displaySkillSmart(key, learned), demand: t.demand, have: haveSkill(key), avgFit: t.fitSum / t.demand }))
    .sort((a, b) => b.demand - a.demand || b.avgFit - a.avgFit)
    .slice(0, 16);
}

export async function GET(req: NextRequest) {
  const userId = await resolveUserId(req.nextUrl.searchParams.get("u"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const wait = req.nextUrl.searchParams.get("refresh") === "1";
  
  // Universal cache validation: check if the scoring vector is missing or stale.
  // This guarantees the Edge ranker never receives a stale/null vector if it doesn't have to.
  const saved = await getSavedScoring(userId);
  if (!saved.scoring || (saved.stale && wait)) {
    try {
      await computeAndSaveScoring(userId);
    } catch (err) {
      console.warn("[/api/matches] inline scoring failed", err);
    }
  } else if (saved.stale) {
    recomputeScoringInBackground(userId);
  }

  const onCF = process.env.DEPLOY_TARGET === "cloudflare";
  // On CF the blend runs in the Supabase Edge Function (rankViaEdge, one fetch);
  // on Node it ranks locally. Both return the same RankOutcome shape.
  const { matches, learning, userSkillKeys } = onCF
    ? await rankViaEdge(userId)
    : await rankMatchesWithMeta(userId, { wait });
  const spectrum = pickSpectrum(matches);
  // userSkillKeys rides along from the ranking RPC — zero extra DB round-trips.
  // Learned casing skips on CF (its pool-wide scan is Node-cached; cosmetic —
  // canon + title-case fallback still applies).
  const learned = onCF ? new Map<string, string>() : await getLearnedSkillCasing();
  const radar = skillRadar(matches, userSkillKeys, learned);
  return NextResponse.json({ ok: true, count: matches.length, matches, spectrum, learning, skillRadar: radar });
}
