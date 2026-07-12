/**
 * Explored-paths — the exploration memory. Every direction a user samples (a card
 * dive, later an exploration-stance insight) becomes a saved branch. Re-diving a
 * path bumps its visit count + recency instead of duplicating — so the row is both
 * a journey log and a pricing-gate signal (`committedAt` marks the paid step-up).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { exploredPaths, profiles } from "@/db/schema";
import { ensureProfile } from "@/lib/profile/ensure";

export type ExploredInput = {
  label: string;
  company?: string | null;
  kind?: string | null;
  source?: string;
  summary?: Record<string, unknown>;
};

/** Record (or bump) a sampled path. Returns the branch id, or null if no label. */
export async function recordExploredPath(userId: string, input: ExploredInput): Promise<string | null> {
  const label = input.label?.trim();
  if (!label) return null;
  const profileId = await ensureProfile(userId);

  // dedup by profile + case-insensitive label — a re-dive is a revisit, not a new branch
  const [existing] = await db
    .select({ id: exploredPaths.id, summary: exploredPaths.summary })
    .from(exploredPaths)
    .where(and(eq(exploredPaths.profileId, profileId), sql`lower(${exploredPaths.label}) = lower(${label})`))
    .limit(1);

  if (existing) {
    await db
      .update(exploredPaths)
      .set({
        visitCount: sql`${exploredPaths.visitCount} + 1`,
        lastVisitedAt: new Date(),
        summary: { ...(existing.summary ?? {}), ...(input.summary ?? {}) },
        ...(input.company ? { company: input.company } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
      })
      .where(eq(exploredPaths.id, existing.id));
    return existing.id;
  }

  const [row] = await db
    .insert(exploredPaths)
    .values({
      profileId,
      label,
      company: input.company ?? null,
      kind: input.kind ?? null,
      source: input.source ?? "card_dive",
      summary: input.summary ?? {},
    })
    .returning({ id: exploredPaths.id });
  return row?.id ?? null;
}

/** Mark a branch committed — the paid step-up moment (intro + apply kit). Scoped
 *  to the user's own paths. This is the pricing-gate signal. Returns the thematic
 *  directionTag (falling back to the raw label) so the caller can make it the
 *  user's target direction (recs retune toward the theme, not the JD). */
export async function markCommitted(userId: string, id: string): Promise<{ label: string } | null> {
  const [p] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, userId)).limit(1);
  if (!p) return null;
  const [row] = await db
    .update(exploredPaths)
    .set({ committedAt: new Date() })
    .where(and(eq(exploredPaths.id, id), eq(exploredPaths.profileId, p.id)))
    .returning({ label: exploredPaths.label, summary: exploredPaths.summary });
  if (!row) return null;
  const tag = typeof row.summary?.directionTag === "string" ? row.summary.directionTag : null;
  return { label: tag || row.label };
}

/** Undo a commit — clears committed_at so the user can re-choose (they committed
 *  by mistake, or changed their mind). Scoped to the user's own paths. */
export async function markUncommitted(userId: string, id: string): Promise<boolean> {
  const [p] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, userId)).limit(1);
  if (!p) return false;
  const [row] = await db
    .update(exploredPaths)
    .set({ committedAt: null })
    .where(and(eq(exploredPaths.id, id), eq(exploredPaths.profileId, p.id)))
    .returning({ id: exploredPaths.id });
  return !!row;
}

/** All branches for a user, most-recently-visited first. Read-only (no profile create). */
export async function listExploredPaths(userId: string) {
  const [p] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, userId)).limit(1);
  if (!p) return [];
  return db
    .select()
    .from(exploredPaths)
    .where(eq(exploredPaths.profileId, p.id))
    .orderBy(desc(exploredPaths.lastVisitedAt));
}
