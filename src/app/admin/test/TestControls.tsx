"use client";

import { useState } from "react";

export default function TestControls({ userId }: { userId: string }) {
  const [busy, setBusy] = useState<null | "flush" | "login">(null);

  async function flush() {
    setBusy("flush");
    try {
      const r = await fetch("/api/admin/test-reset", { method: "POST" });
      if (!r.ok) throw new Error(String(r.status));
      // fresh session is set → land on the dashboard as a brand-new user
      window.location.assign("/dashboard");
    } catch {
      setBusy(null);
      alert("Reset failed — is the dev server in development mode?");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 460 }}>
      <button className="explored-commit" onClick={flush} disabled={!!busy}>
        {busy === "flush" ? "Flushing…" : "🔥 Flush & start fresh as a new user"}
      </button>
      <a
        className="explored-commit"
        href={`/api/auth/dev?u=${encodeURIComponent(userId)}`}
        style={{ textAlign: "center", textDecoration: "none", background: "#333" }}
        onClick={() => setBusy("login")}
      >
        Log in as test user (keep current data)
      </a>
      <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5, margin: 0 }}>
        <b>Flush</b> deletes everything for this test profile (résumé, insights,
        explored paths, matches, signals) and drops you on the dashboard as a
        just-signed-in user with no résumé — the exact first-run CF experience.
        Upload a PDF from there to walk the whole flow.
      </p>
    </div>
  );
}
