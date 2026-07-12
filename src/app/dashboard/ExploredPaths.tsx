"use client";

/**
 * C — the exploration memory, made visible. Every path a user tried on (via a
 * mentor card dive) is a saved branch; here they compare them side by side and
 * COMMIT to one. Exploring is free (the funnel); "commit" is the paid step-up
 * (brokered intro + apply kit) — the pricing gate. Renders nothing until there's
 * at least one branch, so first-timers see no clutter.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api-fetch";
import { displayCompany } from "@/lib/format/company";

type Path = {
  id: string;
  label: string;
  company: string | null;
  kind: string | null;
  summary: Record<string, unknown> | null;
  visitCount: number;
  committedAt: string | null;
  lastVisitedAt: string;
};

// Title Case for direction tags ("marketing automation engineering" → "Marketing
// Automation Engineering"), preserving domain acronyms (AI, ML, GTM, UX, …).
const ACRONYMS = new Set(["ai", "ml", "gtm", "ux", "ui", "api", "saas", "hr", "qa", "devops", "seo", "b2b", "b2c", "llm", "nlp", "ar", "vr", "iot", "crm"]);
function titleCase(s: string): string {
  return s.replace(/[A-Za-z0-9']+/g, (w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)));
}

function ago(iso: string): string {
  const d = Math.max(0, Date.now() - Date.parse(iso));
  const day = 86400000;
  if (d < 3600000) return "just now";
  if (d < day) return `${Math.round(d / 3600000)}h ago`;
  if (d < 7 * day) return `${Math.round(d / day)}d ago`;
  return `${Math.round(d / (7 * day))}w ago`;
}

export default function ExploredPaths({ userId }: { userId: string }) {
  const [paths, setPaths] = useState<Path[] | null>(null);
  const [committing, setCommitting] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/mentor/explored", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setPaths(j.paths ?? []))
      .catch(() => setPaths([]));
  }, [userId]);

  async function commit(id: string) {
    setCommitting(id);
    try {
      const r = await fetch("/api/mentor/explored", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      const j = await r.json().catch(() => ({}));
      setPaths((ps) => ps?.map((p) => (p.id === id ? { ...p, committedAt: new Date().toISOString() } : p)) ?? ps);
      // committing set this path as the target direction → send them up to the
      // recommendations, which re-rank toward it (the ?retuning banner + refetch)
      if (j?.retuned) {
        window.location.assign("/dashboard?retuning=1#recommendations");
        return;
      }
    } catch {
      /* leave the button; they can retry */
    } finally {
      setCommitting(null);
    }
  }

  // Undo a commit (committed by mistake / changed their mind). Optimistic —
  // clears committed_at locally, then persists.
  async function uncommit(id: string) {
    setCommitting(id);
    setPaths((ps) => ps?.map((p) => (p.id === id ? { ...p, committedAt: null } : p)) ?? ps);
    try {
      await fetch("/api/mentor/explored", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, uncommit: true }) });
    } catch {
      /* leave it; the optimistic flip stands until reload */
    } finally {
      setCommitting(null);
    }
  }

  if (!paths || paths.length === 0) return null; // invisible for first-timers

  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <h2>Paths you&apos;ve explored</h2>
        <span className="dash-hint">Every direction you&apos;ve tried on — compare, or commit to one</span>
      </div>
      <div className="explored-grid">
        {paths.map((p) => {
          const why = typeof p.summary?.why === "string" ? (p.summary.why as string) : "";
          // a direction is a trajectory theme, not a JD — show the LLM-minted
          // directionTag; fall back to the raw label for pre-tag legacy rows
          const hasTag = typeof p.summary?.directionTag === "string";
          const heading = titleCase(hasTag ? (p.summary!.directionTag as string) : p.label);
          // proof-point: the concrete role@company that sparked this direction —
          // small, muted, so the theme leads and the example just grounds it
          const example = hasTag ? `${p.label}${p.company ? ` @ ${displayCompany(p.company)}` : ""}` : "";
          const committed = !!p.committedAt;
          return (
            <div className={`explored-card${committed ? " committed" : ""}`} key={p.id}>
              {p.kind && <span className="explored-kind">{p.kind}</span>}
              <div className="explored-label">{heading}</div>
              {example && <div className="explored-co">e.g. {example}</div>}
              {why && <div className="explored-why">{why}</div>}
              <div className="explored-meta">
                explored {p.visitCount}×{p.visitCount > 1 ? "" : ""} · {ago(p.lastVisitedAt)}
              </div>
              {committed ? (
                <div className="explored-committed">
                  ✓ Committed — we&apos;ll line up your intro + apply kit
                  <button
                    type="button"
                    className="explored-undo"
                    onClick={() => uncommit(p.id)}
                    disabled={committing === p.id}
                    style={{ marginLeft: 8, background: "none", border: "none", color: "var(--muted)", textDecoration: "underline", cursor: "pointer", font: "inherit", fontSize: 12.5, padding: 0 }}
                  >
                    {committing === p.id ? "…" : "Undo"}
                  </button>
                </div>
              ) : (
                <button className="explored-commit" onClick={() => commit(p.id)} disabled={committing === p.id}>
                  {committing === p.id ? "…" : "Commit to this path →"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
