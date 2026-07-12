/**
 * POST /api/admin/test-reset — dev-only. Wipes the fixed test user's data and
 * recreates a BARE profile (no résumé, no insights, no scoring), then logs in as
 * them. Result: the app behaves exactly like a brand-new CF user who just signed
 * in with LinkedIn but hasn't uploaded anything yet — the first-run experience.
 *
 * Every child table cascades off profiles.id, so deleting the profile row clears
 * experiences / skills / insights / explored paths / signals / résumé versions /
 * applications in one shot. opportunities.added_by_profile_id is ON DELETE SET
 * NULL, so the global pool is never touched. Hard-disabled in production.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { makeSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/auth/session";
import { TEST_USER_ID, TEST_USER_EMAIL, TEST_USER_NAME } from "@/lib/dev/test-user";

export const runtime = "nodejs";

export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // delete the profile → all child rows cascade away
  await db.delete(profiles).where(eq(profiles.userId, TEST_USER_ID));
  // recreate a bare profile so "logged in, no résumé yet" is the exact state
  await db.insert(profiles).values({
    userId: TEST_USER_ID,
    fullName: TEST_USER_NAME,
    email: TEST_USER_EMAIL,
  });

  const res = NextResponse.json({ ok: true, userId: TEST_USER_ID });
  res.cookies.set(SESSION_COOKIE, makeSessionToken(TEST_USER_ID), {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
  return res;
}
