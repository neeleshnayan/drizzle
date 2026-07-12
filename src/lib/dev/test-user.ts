/**
 * Fixed identity for the local end-to-end test user — a stable, obviously-fake
 * UUID so "log in as" + "flush and start fresh" always target the same row.
 * Only ever used by the dev-only admin/test tooling (hard-disabled in prod).
 */
export const TEST_USER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const TEST_USER_EMAIL = "test@drizzle.local";
export const TEST_USER_NAME = "Test User";
