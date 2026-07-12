/**
 * /admin/test — dev-only harness for walking the first-run experience end to end
 * against a fixed, disposable test user. Not linked from anywhere; hard-disabled
 * (404) in production.
 */
import { notFound } from "next/navigation";
import TestControls from "./TestControls";
import { TEST_USER_ID } from "@/lib/dev/test-user";

export const dynamic = "force-dynamic";

export default function TestPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "48px 20px" }}>
      <h1 style={{ fontSize: 22, marginBottom: 6 }}>Local test harness</h1>
      <p style={{ fontSize: 13.5, color: "var(--muted)", marginBottom: 8 }}>
        Simulates a new Cloudflare user locally. Test id:{" "}
        <code style={{ fontSize: 12 }}>{TEST_USER_ID}</code>
      </p>
      <div style={{ marginTop: 24 }}>
        <TestControls userId={TEST_USER_ID} />
      </div>
    </main>
  );
}
