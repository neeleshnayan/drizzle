/**
 * Free-tier spend cap. Payments aren't enabled yet, so each account gets a fixed
 * budget of OpenRouter (LLM) spend — a hard block, not a warning. The mentor
 * VOICE call bills through Deepgram separately and is NOT counted here (this is
 * OpenRouter-only, per the GTM call). Fail-OPEN: a metering error must never
 * wedge the product for a paying-attention user.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";

export const USER_SPEND_CAP_USD = Number(process.env.USER_SPEND_CAP_USD ?? 5);

export class SpendCapError extends Error {
  readonly code = "SPEND_CAP";
  constructor(public readonly spent: number) {
    super(
      "You've used up the free AI credits on your drizzle account. You're on the waitlist for more — we'll be in touch soon.",
    );
    this.name = "SpendCapError";
  }
}

// tiny per-process cache — we check the cap before EVERY agent call, and summing
// agent_runs each time would add a query to every LLM hit. 20s staleness means a
// user can slip a couple extra calls right as they cross the line; that's fine.
const cache = new Map<string, { at: number; spent: number }>();
const TTL_MS = 20_000;

/** Total OpenRouter $ this user has spent (by profile FK OR the userId stashed in
 *  agent_runs.meta for profile-less runs). Cached briefly. Fails to 0 on error. */
export async function getUserSpendUsd(userId: string): Promise<number> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.spent;
  let spent = 0;
  try {
    const res = await db.execute(sql`
      select coalesce(sum(ar.cost_usd::float8), 0) as spent
      from agent_runs ar
      left join profiles p on p.id = ar.profile_id
      where p.user_id = ${userId}::uuid or ar.meta->>'userId' = ${userId}
    `);
    const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as { spent?: number | string }[];
    spent = Number(rows[0]?.spent ?? 0) || 0;
  } catch {
    spent = 0; // fail-open
  }
  cache.set(userId, { at: Date.now(), spent });
  return spent;
}

/** Throw SpendCapError if the user is at/over their budget. No-op if the cap is
 *  disabled (USER_SPEND_CAP_USD <= 0). */
export async function assertUnderCap(userId: string): Promise<void> {
  if (!Number.isFinite(USER_SPEND_CAP_USD) || USER_SPEND_CAP_USD <= 0) return;
  const spent = await getUserSpendUsd(userId);
  if (spent >= USER_SPEND_CAP_USD) throw new SpendCapError(spent);
}
