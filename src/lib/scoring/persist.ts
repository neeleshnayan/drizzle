/**
 * The scoring vector is expensive (big model), so it's cached on the profile.
 * Résumé/insight edits mark it stale (invalidateScoring); the next ranking read
 * recomputes it lazily. Read paths serve the saved value until then, so a stale
 * vector never leaves the user with no recommendations.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { profiles, scoringSnapshots } from "@/db/schema";
import { getFullProfile } from "@/lib/profile/read";
import { getMentorMap } from "@/lib/profile/map";
import { buildProfileText } from "@/lib/scoring/profileText";
import { runAgent } from "@/agents/run";
import { profileScorer } from "@/agents/profile-scorer";

const computing = new Map<string, Promise<Record<string, unknown>>>();

/** Recompute the scoring vector and cache it on the profile. Returns the vector. */
export async function computeAndSaveScoring(userId: string): Promise<Record<string, unknown>> {
  if (computing.has(userId)) {
    return computing.get(userId)!;
  }
  const promise = (async () => {
    const [full, map] = await Promise.all([getFullProfile(userId), getMentorMap(userId)]);
    if (!full) throw new Error("No profile for this user");
    const profileText = buildProfileText(full, map.insights);
    const { output } = await runAgent(profileScorer, { profileText }, { userId });
    const scoring = output as Record<string, unknown>;
    await db.update(profiles).set({ scoring, scoringAt: new Date(), scoringStale: false }).where(eq(profiles.userId, userId));
    // history, never overwritten — powers "how the mentor's read of you evolved"
    try {
      const [p] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, userId)).limit(1);
      if (p) await db.insert(scoringSnapshots).values({ profileId: p.id, vector: scoring });
    } catch {
      /* history is best-effort; the hot cache above is what matters */
    }
    return scoring;
  })();
  computing.set(userId, promise);
  try {
    return await promise;
  } finally {
    computing.delete(userId);
  }
}

export async function getSavedScoring(
  userId: string,
): Promise<{ scoring: Record<string, unknown> | null; scoringAt: Date | null; stale: boolean }> {
  const [p] = await db
    .select({ scoring: profiles.scoring, scoringAt: profiles.scoringAt, scoringStale: profiles.scoringStale })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  return { scoring: p?.scoring ?? null, scoringAt: p?.scoringAt ?? null, stale: p?.scoringStale ?? false };
}

/** Mark the scoring vector stale — call after any résumé/insight edit. Cheap;
 *  the next ranking read recomputes it. Safe to fire-and-forget. */
export async function invalidateScoring(userId: string): Promise<void> {
  try {
    await db.update(profiles).set({ scoringStale: true }).where(eq(profiles.userId, userId));
  } catch {
    /* invalidation is best-effort — worst case the recompute happens one edit later */
  }
}

// The scoring recompute is a big-model call. Ranking READS must never block on
// it — they serve the cached (possibly stale) vector and kick the recompute off
// here so the NEXT read is fresh. Deduped: the dashboard/editor/mentor screens
// all poll matches, so without a guard a burst of polls would stack up N
// concurrent LLM passes and thrash the one GPU. In-process Map is enough locally
// (single Node); on a multi-instance deploy the scoring_stale flag still
// converges once any instance's recompute wins.
export function recomputeScoringInBackground(userId: string): void {
  if (computing.has(userId)) return;
  void computeAndSaveScoring(userId).catch(() => {
    /* stale flag stays set → a later read retries; never surfaced to the user */
  });
}
