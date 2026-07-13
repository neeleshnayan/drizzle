/**
 * Dev-only: when the session is impersonating the fixed test user (via the
 * /admin/test harness), show a persistent banner so you never mistake it for a
 * real account — with a one-click exit that clears the session. Renders nothing
 * for real users and in production.
 */
import { getSessionUserId } from "@/lib/auth/session";
import { TEST_USER_ID } from "@/lib/dev/test-user";

export default async function TestUserBanner() {
  if (process.env.NODE_ENV === "production") return null;
  const userId = await getSessionUserId();
  if (userId !== TEST_USER_ID) return null;
  return (
    <div
      style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center", gap: 12,
        padding: "6px 14px", fontSize: 12.5, fontWeight: 600,
        background: "#7a3b12", color: "#ffe9d6", borderBottom: "1px solid #a2551f",
        letterSpacing: "0.02em",
      }}
    >
      🧪 Viewing as TEST USER (admin/test harness) — not a real account
      <a href="/api/auth/logout" style={{ color: "#fff", textDecoration: "underline" }}>Exit</a>
    </div>
  );
}
