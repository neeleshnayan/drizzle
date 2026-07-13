"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatComp } from "@/lib/format/comp";

type Metrics = {
  mentorCalls: { total: number; byUser: { who: string; n: number; last_at: string }[] };
  resumeEdits: { total: number; users: number };
  applications: { total: number; users: number; last7: number };
  activity: { active_today: number; active_week: number; registered: number; new_week: number } | null;
  byModel: { model: string; runs: number; tokens_in: number; tokens_out: number; cost_usd: number }[];
  spendByUser: { who: string; runs: number; turns: number; cost_usd: number; tokens_in: number; tokens_out: number; last_at: string }[];
  agents: {
    agent: string;
    runs: number;
    errors: number;
    avg_ms: number | null;
    tokens_in: number;
    tokens_out: number;
    last_at: string;
  }[];
  recentRuns: { agent: string; status: string; model: string | null; duration_ms: number | null; error: string | null; created_at: string }[];
  latestUsers?: { who: string; email: string | null; created_at: string; linkedin: boolean; exp: number; calls: number; applied: number }[];
  mentorDiary?: {
    lane: { holder: { userId: string; forSec: number } | null; waitingCount: number };
    insights: { dimension: string; content: string; stance: string | null; confidence: number | null; who: string; created_at: string }[];
    pastCalls: { created_at: string; duration_sec: number | null; summary: string; who: string }[];
  };
};

const fmtMs = (ms: number | null) => (ms == null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtAgo = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

// $/Mtok for hosted models — local models are ₹0 (your rig). This is THE
// dollars-per-outcome view: tokens × price, per model.
const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-opus-4-8": { in: 15, out: 75 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
};
function estCost(model: string, tokensIn: number, tokensOut: number): number {
  const p = Object.entries(PRICE_PER_MTOK).find(([k]) => model.includes(k))?.[1];
  if (!p) return 0;
  return (tokensIn / 1e6) * p.in + (tokensOut / 1e6) * p.out;
}
// prefer the REAL cost OpenRouter logged; fall back to the token estimate
const rowCost = (r: { cost_usd?: number; model?: string; tokens_in: number; tokens_out: number }) =>
  r.cost_usd && r.cost_usd > 0 ? r.cost_usd : estCost(r.model ?? "", r.tokens_in, r.tokens_out);

type Tab = "usage" | "inference" | "jobs";

type JobRow = {
  id: string;
  source: string;
  title: string | null;
  company: string | null;
  location: string | null;
  remote: string | null;
  compMin: number | null;
  compMax: number | null;
  domain: string | null;
  companyStage: string | null;
  url: string | null;
  vectorizedAt: string | null;
  createdAt: string;
  model: string | null;
  promptV: number | null;
  needsReview: boolean;
  hasEmbedding: boolean;
  hasBge: boolean;
};

export default function AdminPanel() {
  const [m, setM] = useState<Metrics | null>(null);
  const [err, setErr] = useState("");
  const [fetching, setFetching] = useState(false);
  const [inferring, setInferring] = useState(false);
  const [inferCount, setInferCount] = useState("10");
  const [inferBatch, setInferBatch] = useState("5");
  const [inferPause, setInferPause] = useState("30");
  const [forceRevec, setForceRevec] = useState(false); // re-vectorize already-done rows too
  type Progress = { running: boolean; total: number; done: number; failed: number; current: string | null };
  const [prog, setProg] = useState<Progress | null>(null);
  // poll live progress while a run is active
  useEffect(() => {
    if (!inferring) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch("/api/admin/run-inference", { cache: "no-store" });
        const j = await r.json();
        if (r.ok) setProg(j.progress);
      } catch {}
    }, 2500);
    return () => clearInterval(id);
  }, [inferring]);
  const [fetchLog, setFetchLog] = useState<string[] | null>(null);

  // 🚑 local rescue — dev-only tooling to un-wedge the GPU stack mid-demo
  const [rescueBusy, setRescueBusy] = useState<string | null>(null);
  const [rescueLog, setRescueLog] = useState<string[]>([]);
  async function rescue(action: string) {
    setRescueBusy(action);
    setRescueLog((l) => [...l, `▶ ${action}…`]);
    try {
      const r = await fetch("/api/admin/rescue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      setRescueLog((l) => [...l, ...(j.log ?? [j.error ?? "failed"])]);
    } catch (e) {
      setRescueLog((l) => [...l, `! ${e instanceof Error ? e.message : "request failed"}`]);
    } finally {
      setRescueBusy(null);
    }
  }
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [pending, setPending] = useState(0);
  // bge-m3 pool embedding (local ollama) — backlog counts + one-click run
  const [bge, setBge] = useState<{ gemma4Needed: number; bgeNeeded: number; total?: number } | null>(null);
  const [bgeBusy, setBgeBusy] = useState(false);
  const [bgeTarget, setBgeTarget] = useState("200");
  const [bgeMsg, setBgeMsg] = useState<string | null>(null);
  const refreshBge = () =>
    fetch("/api/admin/embed-bge", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (j.ok) setBge({ gemma4Needed: j.gemma4Needed, bgeNeeded: j.bgeNeeded, total: j.total }); })
      .catch(() => {});
  useEffect(() => { void refreshBge(); }, []);
  const [tab, setTab] = useState<Tab>("usage");
  const [jobsTotal, setJobsTotal] = useState(0);
  const [jobStatus, setJobStatus] = useState<"all" | "pending" | "vectorized">("all");
  const [jobQ, setJobQ] = useState("");
  const [jobModel, setJobModel] = useState(""); // "" = any, or a model / "none"
  const [jobMissing, setJobMissing] = useState<"" | "comp" | "yoe" | "remote">("");
  const [jobFlagged, setJobFlagged] = useState(false);
  const [jobEmbed, setJobEmbed] = useState<"" | "bge" | "none">(""); // bge-embedding filter
  const [jobPage, setJobPage] = useState(0);
  const PAGE = 50;
  type JobFilter = { status: "all" | "pending" | "vectorized"; q: string; model: string; missing: string; flagged: boolean; embed: string; page: number };
  type Stats = {
    verticals: { vertical: string; total: number; done: number }[];
    boards: { company: string | null; total: number; done: number }[];
    models: { model: string; n: number }[];
    missing: { noComp: number; noYoe: number; noRemote: number; flaggedN: number };
  };
  const [stats, setStats] = useState<Stats | null>(null);

  // Current filter params live in a REF so every caller — including the
  // post-inference refresh — reloads what the user is actually looking at.
  // (A stale closure here once refreshed the "all" list while the operator sat
  // on the vectorized tab, hiding freshly processed jobs.)
  const jobParamsRef = useRef<JobFilter>({ status: "all", q: "", model: "", missing: "", flagged: false, embed: "", page: 0 });

  // paged on purpose — a 500-row dump once crashed the operator's browser
  const loadJobs = useCallback(async (over?: Partial<JobFilter>) => {
    const next = { ...jobParamsRef.current, ...over };
    jobParamsRef.current = next;
    try {
      const params = new URLSearchParams({ status: next.status, limit: String(PAGE), offset: String(next.page * PAGE) });
      if (next.q.trim()) params.set("q", next.q.trim());
      if (next.model) params.set("model", next.model);
      if (next.missing) params.set("missing", next.missing);
      if (next.flagged) params.set("flagged", "1");
      if (next.embed) params.set("embed", next.embed);
      const r = await fetch(`/api/admin/jobs?${params}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setJobs(j.jobs ?? []);
      setJobsTotal(j.total ?? 0);
      setPending(j.pending ?? 0);
      setStats(j.stats ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load jobs");
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const rm = await fetch("/api/admin/metrics", { cache: "no-store" });
      const jm = await rm.json();
      if (!rm.ok) throw new Error(jm.error);
      setM(jm);
      setErr("");
      void loadJobs(); // refreshes whatever filter/page the user is on
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }, [loadJobs]);
  useEffect(() => {
    void load();
  }, [load]);
  function setJobFilter(status: "all" | "pending" | "vectorized") {
    setJobStatus(status);
    setJobPage(0);
    void loadJobs({ status, page: 0 });
  }
  function setJobPageAndLoad(page: number) {
    setJobPage(page);
    void loadJobs({ page });
  }

  // phase 1 — cheap board pull, no GPU
  async function refreshJobs() {
    setFetching(true);
    setFetchLog(["Pulling boards (no inference — that's the separate button)…"]);
    try {
      const r = await fetch("/api/admin/refresh-jobs", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setFetchLog(j.log ?? []);
      await load();
    } catch (e) {
      setFetchLog([`Failed: ${e instanceof Error ? e.message : "unknown error"}`]);
    } finally {
      setFetching(false);
    }
  }

  // graceful stop — the run finishes the current row, embeds what completed, exits
  async function stopCrunch() {
    setFetchLog((l) => [...(l ?? []), "⏹ Stop requested — finishing the current row, then embedding what completed…"]);
    try { await fetch("/api/admin/run-inference", { method: "DELETE" }); } catch { /* best effort */ }
  }

  // phase 2 — GPU inference, fully operator-controlled: total, batch, cooldown
  async function runInference() {
    setInferring(true);
    const n = Math.max(1, parseInt(inferCount, 10) || 10);
    const b = Math.max(1, parseInt(inferBatch, 10) || 5);
    const p = Math.max(0, parseInt(inferPause, 10) || 30);
    setFetchLog([`${forceRevec ? "Re-vectorizing" : "Vectorizing"} up to ${n} job(s) — batches of ${b}, ${p}s cooldown. Leave this page open…`]);
    try {
      const r = await fetch("/api/admin/run-inference", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: n, batch: b, sleepSec: p, force: forceRevec, tiered: true }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setFetchLog(j.log ?? []);
      await load();
    } catch (e) {
      setFetchLog([`Failed: ${e instanceof Error ? e.message : "unknown error"}`]);
    } finally {
      setInferring(false);
      setProg(null);
    }
  }

  // bge-m3 embedding (local ollama). Loops in 500-row server batches until it hits
  // the target row count — or, in drain mode, until the whole pool is embedded —
  // streaming live progress so an operator can watch it work and walk away.
  async function runBge(drainAll = false) {
    setBgeBusy(true);
    const target = drainAll ? Infinity : Math.max(1, parseInt(bgeTarget, 10) || 200);
    let done = 0;
    setBgeMsg("Starting bge-m3 (local ollama)…");
    try {
      while (done < target) {
        const batch = Math.min(500, drainAll ? 500 : target - done);
        const r = await fetch("/api/admin/embed-bge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ count: batch }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        done += j.embedded;
        setBge((b) => (b ? { ...b, bgeNeeded: j.remaining } : b));
        setBgeMsg(`Embedded ${done} this run · ${j.remaining} left in pool`);
        if (j.embedded === 0 || j.remaining === 0) break; // drained / nothing eligible
      }
      setBgeMsg((m) => `${m ?? ""} — done ✓`);
    } catch (e) {
      setBgeMsg(`Failed after ${done}: ${e instanceof Error ? e.message : "unknown error"} (is bge-m3 pulled? \`ollama pull bge-m3\`)`);
    } finally {
      setBgeBusy(false);
      void refreshBge();
    }
  }

  async function deleteJob(id: string) {
    await fetch(`/api/admin/jobs?id=${id}`, { method: "DELETE" });
    setJobs((cur) => cur.filter((j) => j.id !== id));
  }

  // expandable extraction view: what did the model actually pull out of the JD?
  type JobDetail = {
    facts: Record<string, unknown> | null;
    vector: Record<string, { score?: number; rationale?: string }> | null;
    jdChars: number;
  };
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, JobDetail>>({});
  async function toggleDetail(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!details[id]) {
      try {
        const r = await fetch(`/api/admin/jobs?id=${id}`, { cache: "no-store" });
        const j = await r.json();
        if (r.ok) setDetails((d) => ({ ...d, [id]: j }));
      } catch {}
    }
  }

  if (err) return <div className="admin-wrap"><p className="ai-err">{err}</p></div>;
  if (!m) return <div className="admin-wrap"><p className="dash-empty">Loading metrics…</p></div>;

  const totalSpend = m.byModel.reduce((s, x) => s + rowCost(x), 0);

  return (
    <div className="admin-wrap">
      <div className="admin-head">
        <h1>Control room</h1>
        <span className="admin-head-actions">
          <a className="refine-toggle" href="/dashboard">← Back to drizzle</a>
          <button className="refine-toggle" onClick={() => void load()}>↻ Reload</button>
        </span>
      </div>

      <div className="admin-tabs">
        {(["usage", "inference", "jobs"] as Tab[]).map((t) => (
          <button key={t} className={`admin-tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {t === "usage" ? "📊 Usage" : t === "inference" ? "🧮 LLM inference" : `⚙ Jobs${pending ? ` (${pending} pending)` : ""}`}
          </button>
        ))}
      </div>

      {tab === "usage" && (
        <>
          {process.env.NODE_ENV !== "production" && (
            <section className="admin-section rescue-section">
              <h2>🚑 Local rescue <span className="admin-dim" style={{ fontWeight: 400, fontSize: 12 }}>— when a demo wedges, don&apos;t debug: press the button</span></h2>
              <div className="admin-actions" style={{ marginTop: 6 }}>
                <button className="btn-primary" onClick={() => void rescue("full")} disabled={!!rescueBusy}>
                  {rescueBusy === "full" ? "Rescuing…" : "🚑 Fix it (full ladder)"}
                </button>
                <button className="refine-toggle" onClick={() => void rescue("warm")} disabled={!!rescueBusy}>
                  {rescueBusy === "warm" ? "Warming…" : "🔥 Warm models"}
                </button>
                <button className="refine-toggle" onClick={() => void rescue("restart-ollama")} disabled={!!rescueBusy}>
                  {rescueBusy === "restart-ollama" ? "Restarting…" : "↻ Restart Ollama"}
                </button>
                <button className="refine-toggle" onClick={() => void rescue("restart-voicebox")} disabled={!!rescueBusy}>
                  {rescueBusy === "restart-voicebox" ? "Restarting…" : "↻ Restart voicebox"}
                </button>
                <button className="refine-toggle" onClick={() => void rescue("evict-stock")} disabled={!!rescueBusy}>
                  ⚔ Evict stock Ollama
                </button>
              </div>
              <p className="admin-note" style={{ marginTop: 8 }}>
                Full ladder = evict :11434 squatter → test generation → restart rc Ollama if wedged → restart voicebox if STILL
                wedged (zombie CUDA state blocks new GPU contexts) → warm the live model. Dev builds only; the endpoint 404s in production.
              </p>
              {rescueLog.length > 0 && (
                <pre className="rescue-log">{rescueLog.join("\n")}</pre>
              )}
            </section>
          )}
          <div className="admin-stats">
            <div className="admin-stat">
              <div className="admin-stat-n">{m.activity?.active_today ?? 0}</div>
              <div className="admin-stat-l">Active today · {m.activity?.active_week ?? 0} this week</div>
            </div>
            <div className="admin-stat">
              <div className="admin-stat-n">{m.activity?.registered ?? 0}</div>
              <div className="admin-stat-l">Registered · {m.activity?.new_week ?? 0} new this week</div>
            </div>
            <div className="admin-stat">
              <div className="admin-stat-n">{m.mentorCalls.total}</div>
              <div className="admin-stat-l">Mentor conversations</div>
            </div>
            <div className="admin-stat">
              <div className="admin-stat-n">{m.resumeEdits.total}</div>
              <div className="admin-stat-l">Résumé edits · {m.resumeEdits.users} user{m.resumeEdits.users === 1 ? "" : "s"}</div>
            </div>
            <div className="admin-stat">
              <div className="admin-stat-n">{m.applications.total}</div>
              <div className="admin-stat-l">Applications · {m.applications.last7} this week</div>
            </div>
          </div>
          <p className="admin-note">
            &ldquo;Active&rdquo; = any recorded action (upload, edit, call). Real session tracking lands with the first outside users.
          </p>

          {m.latestUsers && m.latestUsers.length > 0 && (
            <section className="admin-section">
              <h2>Latest signups <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 13 }}>· newest first, scroll for more</span></h2>
              <div style={{ maxHeight: 360, overflowY: "auto", border: "1px solid rgba(230,210,170,0.14)", borderRadius: 10 }}>
                {m.latestUsers.map((u, i) => (
                  <div
                    key={i}
                    style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 14px", fontSize: 13.5, borderBottom: i < m.latestUsers!.length - 1 ? "1px solid rgba(230,210,170,0.07)" : "none" }}
                  >
                    <div style={{ width: 22, color: "var(--muted)", fontSize: 12, flexShrink: 0 }}>{i + 1}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.who}</div>
                      {u.email && u.email !== u.who && <div style={{ color: "var(--muted)", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.email}</div>}
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0, fontSize: 11.5 }}>
                      {u.linkedin && <span title="Signed in with LinkedIn" style={{ padding: "2px 7px", borderRadius: 6, background: "rgba(216,142,106,0.14)", color: "#E0A579" }}>in</span>}
                      {u.exp > 0 && <span title="Résumé uploaded" style={{ padding: "2px 7px", borderRadius: 6, background: "rgba(230,210,170,0.10)", color: "var(--muted)" }}>📄</span>}
                      {u.calls > 0 && <span title={`${u.calls} mentor call(s)`} style={{ padding: "2px 7px", borderRadius: 6, background: "rgba(230,210,170,0.10)", color: "var(--muted)" }}>🎙 {u.calls}</span>}
                      {u.applied > 0 && <span title={`${u.applied} application(s)`} style={{ padding: "2px 7px", borderRadius: 6, background: "rgba(230,210,170,0.10)", color: "var(--muted)" }}>✉ {u.applied}</span>}
                    </div>
                    <div style={{ color: "var(--muted)", fontSize: 12, flexShrink: 0, width: 96, textAlign: "right" }}>{new Date(u.created_at).toLocaleDateString()}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="admin-section">
            <h2>Mentor conversations by user</h2>
            {m.mentorCalls.byUser.length === 0 ? (
              <p className="dash-empty">None yet.</p>
            ) : (
              <table className="admin-table">
                <thead><tr><th>User</th><th>Calls</th><th>Last</th></tr></thead>
                <tbody>
                  {m.mentorCalls.byUser.map((u, i) => (
                    <tr key={i}><td>{u.who}</td><td>{u.n}</td><td>{fmtAgo(u.last_at)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="admin-section">
            <h2>Mentor diary</h2>
            <p className="admin-note" style={{ marginTop: 0 }}>
              Lane:{" "}
              {m.mentorDiary?.lane?.holder
                ? `🔴 live call in progress (${Math.round((m.mentorDiary.lane.holder.forSec ?? 0) / 60)} min)`
                : "🟢 free"}
              {m.mentorDiary?.lane?.waitingCount ? ` · ${m.mentorDiary.lane.waitingCount} waiting` : ""}
            </p>
            <div className="diary-grid">
              <div>
                <h3 className="diary-h">What the mentor&apos;s learned</h3>
                {!m.mentorDiary?.insights?.length ? (
                  <p className="dash-empty">No insights captured yet (they persist at review-save).</p>
                ) : (
                  <table className="admin-table">
                    <thead><tr><th>Who</th><th>Dimension</th><th>Insight</th><th>When</th></tr></thead>
                    <tbody>
                      {m.mentorDiary.insights.map((ins, i) => (
                        <tr key={i}>
                          <td>{ins.who}</td>
                          <td>
                            {ins.dimension}
                            {ins.stance === "exploration" ? <span className="admin-dim"> · exploring</span> : ins.stance === "conviction" ? <span className="admin-dim"> · conviction</span> : ""}
                          </td>
                          <td className="admin-dim">{ins.content}</td>
                          <td>{fmtAgo(ins.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div>
                <h3 className="diary-h">Calls that happened</h3>
                {!m.mentorDiary?.pastCalls?.length ? (
                  <p className="dash-empty">No recapped calls yet (recaps persist at review-save).</p>
                ) : (
                  <table className="admin-table">
                    <thead><tr><th>When</th><th>Who</th><th>Len</th><th>Recap</th></tr></thead>
                    <tbody>
                      {m.mentorDiary.pastCalls.map((c, i) => (
                        <tr key={i}>
                          <td>{fmtAgo(c.created_at)}</td>
                          <td>{c.who}</td>
                          <td>{c.duration_sec ? `${Math.round(c.duration_sec / 60)}m` : "—"}</td>
                          <td className="admin-dim">{c.summary}…</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>
        </>
      )}

      {tab === "inference" && (
        <>
          <div className="admin-stats">
            <div className="admin-stat">
              <div className="admin-stat-n">${totalSpend.toFixed(2)}</div>
              <div className="admin-stat-l">Est. hosted-LLM spend (all time)</div>
            </div>
            <div className="admin-stat">
              <div className="admin-stat-n">{m.agents.reduce((s, a) => s + a.runs, 0)}</div>
              <div className="admin-stat-l">Agent runs · {m.agents.reduce((s, a) => s + a.errors, 0)} errors</div>
            </div>
            {/* agent_runs misses vectorization — the extract/embed path doesn't go
                through runAgent, so it never logs there. The DB row counts (same
                stat the Jobs tab shows) are the real vectorize ledger. */}
            {(() => {
              const done = (stats?.models ?? []).filter((x) => x.model !== "none");
              const total = done.reduce((s, x) => s + x.n, 0);
              const breakdown = [...done].sort((a, b) => b.n - a.n).map((x) => `${x.model.split(":")[0]} ${x.n.toLocaleString()}`).join(" · ");
              return (
                <div className="admin-stat" title="Opportunities with a stored vector, by model — the ground truth (agent_runs undercounts because the vectorize path bypasses that log)">
                  <div className="admin-stat-n">{total.toLocaleString()}</div>
                  <div className="admin-stat-l">Roles vectorized{breakdown ? ` · ${breakdown}` : ""}</div>
                </div>
              );
            })()}
          </div>

          <section className="admin-section">
            <h2>Spend by user <span className="admin-dim" style={{ fontWeight: 400, fontSize: 12 }}>— OpenRouter $ is real; local rows are $0</span></h2>
            {m.spendByUser.length === 0 ? (
              <p className="dash-empty">No agent runs logged yet.</p>
            ) : (
              <table className="admin-table">
                <thead><tr><th>User</th><th>Runs</th><th>Mentor turns</th><th>Tokens in/out</th><th>Cost</th><th>Last</th></tr></thead>
                <tbody>
                  {m.spendByUser.map((u, i) => {
                    const c = rowCost(u);
                    return (
                      <tr key={i}>
                        <td>{u.who}</td>
                        <td>{u.runs}</td>
                        <td>{u.turns || "—"}</td>
                        <td>{fmtK(u.tokens_in)} / {fmtK(u.tokens_out)}</td>
                        <td>{c > 0 ? `$${c.toFixed(4)}` : "$0 (local)"}</td>
                        <td>{fmtAgo(u.last_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section className="admin-section">
            <h2>Spend by model</h2>
            <table className="admin-table">
              <thead><tr><th>Model</th><th>Runs</th><th>Tokens in/out</th><th>Cost</th></tr></thead>
              <tbody>
                {m.byModel.map((x) => {
                  const c = rowCost(x);
                  return (
                    <tr key={x.model}>
                      <td>{x.model}</td>
                      <td>{x.runs}</td>
                      <td>{fmtK(x.tokens_in)} / {fmtK(x.tokens_out)}</td>
                      <td>{c > 0 ? `$${c.toFixed(3)}${x.cost_usd > 0 ? "" : " est"}` : "$0 (local)"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="admin-section">
            <h2>By agent — the ROI ledger</h2>
            <table className="admin-table">
              <thead>
                <tr><th>Agent</th><th>Runs</th><th>Errors</th><th>Avg time</th><th>Tokens in/out</th><th>Last</th></tr>
              </thead>
              <tbody>
                {m.agents.map((a) => (
                  <tr key={a.agent}>
                    <td>{a.agent}</td>
                    <td>{a.runs}</td>
                    <td className={a.errors > 0 ? "admin-err" : ""}>{a.errors}</td>
                    <td>{fmtMs(a.avg_ms)}</td>
                    <td>{fmtK(a.tokens_in)} / {fmtK(a.tokens_out)}</td>
                    <td>{fmtAgo(a.last_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="admin-section">
            <h2>Recent runs</h2>
            <table className="admin-table">
              <thead><tr><th>Agent</th><th>Status</th><th>Model</th><th>Time</th><th>When</th></tr></thead>
              <tbody>
                {m.recentRuns.map((r, i) => (
                  <tr key={i}>
                    <td>{r.agent}</td>
                    <td className={r.status === "error" ? "admin-err" : ""}>{r.status}{r.error ? ` — ${r.error.slice(0, 60)}` : ""}</td>
                    <td>{r.model ?? "—"}</td>
                    <td>{fmtMs(r.duration_ms)}</td>
                    <td>{fmtAgo(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      {tab === "jobs" && (
        <>
          <div className="admin-actions" style={{ marginTop: 4 }}>
            <button className="btn-primary" onClick={() => void refreshJobs()} disabled={fetching || inferring}>
              {fetching ? "Pulling boards…" : "⟳ Fetch jobs"}
            </button>
            <span className="admin-infer">
              <label className="admin-knob" title="How many rows this run processes (cap 2000 — enough to sweep the whole pool)">
                total
                <input className="admin-count" type="number" min={1} max={2000} value={inferCount} onChange={(e) => setInferCount(e.target.value)} />
              </label>
              <label className="admin-knob" title="Jobs per batch before a cooldown">
                batch
                <input className="admin-count" type="number" min={1} max={10} value={inferBatch} onChange={(e) => setInferBatch(e.target.value)} />
              </label>
              <label className="admin-knob" title="Seconds of GPU cooldown between batches">
                pause&nbsp;(sec)
                <input className="admin-count" type="number" min={0} max={120} value={inferPause} onChange={(e) => setInferPause(e.target.value)} />
              </label>
              <label className="admin-knob admin-force" title="Backfill: also reprocess rows vectorized BEFORE the schema fixes. Rows already on the new schema are skipped, so this only ever does the ones that need it — repeat until it reports the backfill is complete.">
                <input type="checkbox" checked={forceRevec} onChange={(e) => setForceRevec(e.target.checked)} />
                backfill&nbsp;old
              </label>
              <button
                className="btn-primary"
                onClick={() => void runInference()}
                disabled={inferring || fetching || (!forceRevec && pending === 0)}
                title={forceRevec ? "Only rows NOT yet on the new schema (pending first, then oldest) — already-redone rows are skipped, so it converges to zero" : pending ? `${pending} pending in total — this run only vectorizes what you set in "total"` : undefined}
              >
                {inferring
                  ? forceRevec ? "Backfilling…" : "Vectorizing…"
                  : forceRevec
                    ? `♻ Backfill up to ${Math.min(Number(inferCount) || 10, 2000)}`
                    : `▶ Vectorize ${Math.min(Number(inferCount) || 10, pending || 0)} job${Math.min(Number(inferCount) || 10, pending || 0) === 1 ? "" : "s"}`}
              </button>
              {inferring && (
                <button
                  className="ghost-btn"
                  onClick={() => void stopCrunch()}
                  title="Finish the current row, embed what completed, then stop."
                  style={{ borderColor: "#ef4444", color: "#ef4444" }}
                >
                  ⏹ Stop
                </button>
              )}
            </span>
          </div>
          <p className="admin-note">
            Fetch is cheap (no GPU) — run it anytime. Inference runs <b>gemma3 end to end</b> (~27s/role — granite was
            demoted: it scored every role ~0.6 on every axis, useless for ranking), in batches with a cooldown for thermal
            headroom. <b>Backfill&nbsp;old</b> widens the run to rows that <i>need</i> redoing — pending, pre-schema-fix, or
            granite-era vectors; already-redone rows are skipped, so repeat runs converge and finish with &quot;backfill
            complete&quot;. Heads-up: inference competes with live mentor calls for the GPU — run it between calls.
          </p>

          {/* bge-m3 pool embedding: local ollama, feeds the CF real-time recs. */}
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <b>bge-m3 embeddings</b>
            <span className="admin-note" style={{ margin: 0 }}>
              {bge
                ? `${(bge.total ?? 0) - bge.bgeNeeded}/${bge.total ?? 0} embedded · ${bge.bgeNeeded} to go${bge.gemma4Needed ? ` · ${bge.gemma4Needed} on an older extractor (fine for bge)` : ""}`
                : "loading…"}
            </span>
            <label className="admin-knob">
              rows&nbsp;
              <input className="admin-count" type="number" min={1} max={5000} value={bgeTarget} onChange={(e) => setBgeTarget(e.target.value)} disabled={bgeBusy} />
            </label>
            <button className="btn-primary" onClick={() => void runBge(false)} disabled={bgeBusy || (bge?.bgeNeeded ?? 0) === 0}>
              {bgeBusy ? "Embedding…" : "▶ Run"}
            </button>
            <button
              className="ghost-btn"
              onClick={() => void runBge(true)}
              disabled={bgeBusy || (bge?.bgeNeeded ?? 0) === 0}
              title="Loop 500 at a time until the whole pool is embedded — set it going and walk away"
            >
              ⤓ Drain all
            </button>
            {bgeMsg && <span className="admin-note" style={{ margin: 0 }}>· {bgeMsg}</span>}
          </div>

          {inferring && prog && prog.total > 0 && (
            <div className="infer-progress">
              <div className="infer-progress-bar">
                <div className="infer-progress-fill" style={{ width: `${Math.round(((prog.done + prog.failed) / prog.total) * 100)}%` }} />
              </div>
              <div className="infer-progress-text">
                {prog.done + prog.failed} of {prog.total} · {prog.done} ✓{prog.failed ? ` · ${prog.failed} ✗` : ""}
                {prog.current ? ` — now: ${prog.current}` : ""} · {pending - prog.done} still pending overall
              </div>
            </div>
          )}

          {fetchLog && <pre className="admin-log">{fetchLog.join("\n")}</pre>}

          {stats && (
            <section className="admin-section">
              <h2>Pipeline mix — fetch more of what&apos;s thin</h2>
              <div className="mix-grid">
                <div>
                  <div className="mix-label">By vertical (title-based, all {jobsTotal || "—"} rows)</div>
                  {stats.verticals.map((v) => {
                    const max = Math.max(...stats.verticals.map((x) => x.total), 1);
                    return (
                      <div className="mix-row" key={v.vertical}>
                        <span className="mix-name">{v.vertical}</span>
                        <span className="mix-bar">
                          <span className="mix-fill" style={{ width: `${(v.total / max) * 100}%` }}>
                            <span className="mix-done" style={{ width: `${v.total ? (v.done / v.total) * 100 : 0}%` }} />
                          </span>
                        </span>
                        <span className="mix-n">{v.done}/{v.total}</span>
                      </div>
                    );
                  })}
                  <div className="admin-note">bar = postings in DB · filled part = already vectorized</div>
                </div>
                <div>
                  <div className="mix-label">By board</div>
                  {stats.boards.slice(0, 12).map((b) => (
                    <div className="mix-row" key={b.company ?? "?"}>
                      <span className="mix-name">{b.company ?? "—"}</span>
                      <span className="mix-n">{b.done}/{b.total}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          <section className="admin-section">
            <div className="jobs-controls">
              <h2 style={{ margin: 0 }}>Jobs ({jobsTotal}{pending ? ` · ${pending} pending` : ""})</h2>
              <span className="jobs-filters">
                {(["all", "pending", "vectorized"] as const).map((s) => (
                  <button key={s} className={`admin-tab${jobStatus === s ? " active" : ""}`} onClick={() => setJobFilter(s)}>
                    {s}
                  </button>
                ))}
                <input
                  className="f-box jobs-search"
                  placeholder="search title/company…"
                  value={jobQ}
                  onChange={(e) => setJobQ(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (setJobPage(0), void loadJobs({ q: jobQ, page: 0 }))}
                />
                {/* model filter — driven by the live model distribution */}
                <select
                  className="f-box"
                  value={jobModel}
                  onChange={(e) => { setJobModel(e.target.value); setJobPage(0); void loadJobs({ model: e.target.value, page: 0 }); }}
                  title="Filter by the model that vectorized the row"
                >
                  <option value="">any model</option>
                  {(stats?.models ?? []).map((m) => (
                    <option key={m.model} value={m.model}>{m.model} ({m.n})</option>
                  ))}
                </select>
                {/* missing-field filters — the null IS the flag (no redundant column) */}
                {([["comp", "no comp", stats?.missing.noComp], ["yoe", "no yrs", stats?.missing.noYoe], ["remote", "no style", stats?.missing.noRemote]] as const).map(([k, label, n]) => (
                  <button
                    key={k}
                    className={`admin-tab${jobMissing === k ? " active" : ""}`}
                    onClick={() => { const v = jobMissing === k ? "" : k; setJobMissing(v); setJobPage(0); void loadJobs({ missing: v, page: 0 }); }}
                    title={`Vectorized rows missing this field${n != null ? ` (${n})` : ""}`}
                  >
                    {label}{n != null ? ` ${n}` : ""}
                  </button>
                ))}
                <button
                  className={`admin-tab${jobFlagged ? " active" : ""}`}
                  onClick={() => { const v = !jobFlagged; setJobFlagged(v); setJobPage(0); void loadJobs({ flagged: v, page: 0 }); }}
                  title={`Rows the model self-flagged as likely-wrong${stats?.missing.flaggedN != null ? ` (${stats.missing.flaggedN})` : ""}`}
                >
                  ⚑ flagged{stats?.missing.flaggedN ? ` ${stats.missing.flaggedN}` : ""}
                </button>
                {/* bge-embedding status filter */}
                {([["bge", "bge ✓"], ["none", "no bge"]] as const).map(([k, label]) => (
                  <button
                    key={k}
                    className={`admin-tab${jobEmbed === k ? " active" : ""}`}
                    onClick={() => { const v = jobEmbed === k ? "" : k; setJobEmbed(v); setJobPage(0); void loadJobs({ embed: v, page: 0 }); }}
                    title={k === "bge" ? "Rows with a bge-m3 vector" : "Extracted rows still missing a bge-m3 vector"}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </div>
            <table className="admin-table admin-jobs-table">
              <thead>
                <tr><th>Title</th><th>Company</th><th>Location</th><th>Style</th><th>Comp</th><th>Domain</th><th>Src</th><th>Model</th><th>Status</th><th>Embed</th><th>Added</th><th></th></tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const d = details[j.id];
                  const facts = (d?.facts ?? {}) as {
                    summary?: string;
                    core_requirements?: string[];
                    must_have_skills?: string[];
                  };
                  return [
                    <tr key={j.id} className={expandedId === j.id ? "row-open" : undefined}>
                      <td>
                        {j.vectorizedAt && (
                          <button className="row-expand" onClick={() => void toggleDetail(j.id)} title="What the model extracted">
                            {expandedId === j.id ? "▾" : "▸"}
                          </button>
                        )}
                        {j.url ? <a href={j.url} target="_blank" rel="noopener noreferrer">{j.title}</a> : j.title}
                      </td>
                      <td>{j.company}</td>
                      <td className="admin-dim">{j.location ?? "—"}</td>
                      <td className="admin-dim">{j.remote && j.remote !== "unknown" ? j.remote : "—"}</td>
                      <td className="admin-dim">{formatComp(j.compMin, j.compMax, j.location) ?? "—"}</td>
                      <td className="admin-dim">{j.domain ?? "—"}{j.companyStage && j.companyStage !== "unknown" ? ` · ${j.companyStage}` : ""}</td>
                      <td className="admin-dim">{j.source}</td>
                      <td className="admin-dim" style={{ whiteSpace: "nowrap" }}>
                        {j.model ? (
                          <>
                            <span title={`${j.model}${j.promptV ? ` · prompt v${j.promptV}` : ""}`}>{j.model.replace(/:.*/, "")}{j.promptV ? ` v${j.promptV}` : ""}</span>
                            {j.needsReview && <span title="model self-flagged as likely-wrong" style={{ color: "#e0b45c", marginLeft: 4 }}>⚑</span>}
                            {j.hasEmbedding && <span title="has trajectory embedding" style={{ opacity: 0.55, marginLeft: 4 }}>⊹</span>}
                          </>
                        ) : "—"}
                      </td>
                      <td>{j.vectorizedAt ? <span style={{ whiteSpace: "nowrap" }} title={new Date(j.vectorizedAt).toLocaleString()}>✓ {fmtAgo(j.vectorizedAt)}</span> : <span className="admin-pending">pending</span>}</td>
                      <td className="admin-dim" style={{ whiteSpace: "nowrap" }}>
                        {j.hasBge ? <span title="bge-m3 embedded" style={{ color: "#7bc47f" }}>bge ✓</span>
                          : j.vectorizedAt ? <span title="extracted but no bge vector yet" style={{ color: "#e0b45c" }}>needs bge</span>
                          : <span className="admin-dim">—</span>}
                      </td>
                      <td className="admin-dim">{fmtAgo(j.createdAt)}</td>
                      <td><button className="admin-del" onClick={() => void deleteJob(j.id)} title="Delete this job">✕</button></td>
                    </tr>,
                    expandedId === j.id ? (
                      <tr key={`${j.id}-detail`} className="detail-row">
                        <td colSpan={11}>
                          {!d ? (
                            <span className="admin-dim">Loading extraction…</span>
                          ) : (
                            <div className="job-detail">
                              {facts.summary && <p className="job-detail-summary">{facts.summary}</p>}
                              {(facts.core_requirements?.length ?? 0) > 0 && (
                                <div className="job-detail-block">
                                  <span className="job-detail-label">Core requirements</span>
                                  <ul>{facts.core_requirements!.map((r, i) => <li key={i}>{r}</li>)}</ul>
                                </div>
                              )}
                              {(facts.must_have_skills?.length ?? 0) > 0 && (
                                <div className="job-detail-block">
                                  <span className="job-detail-label">Skills</span>
                                  <span className="admin-dim"> {facts.must_have_skills!.join(" · ")}</span>
                                </div>
                              )}
                              {d.vector && (
                                <div className="job-detail-block">
                                  <span className="job-detail-label">Vector ({d.jdChars.toLocaleString()} JD chars)</span>
                                  <div className="vec-grid">
                                    {Object.entries(d.vector).map(([k, v]) => (
                                      <span className="vec-chip" key={k} title={v?.rationale ?? ""}>
                                        {k.replace(/^(req|off)_/, "").replace(/_/g, " ")} <b>{(v?.score ?? 0).toFixed(1)}</b>
                                      </span>
                                    ))}
                                  </div>
                                  <div className="admin-note">hover a chip for the model&apos;s rationale</div>
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
            <div className="jobs-pager">
              <button className="refine-toggle" disabled={jobPage === 0} onClick={() => setJobPageAndLoad(jobPage - 1)}>← Prev</button>
              <span className="dash-hint">page {jobPage + 1} of {Math.max(1, Math.ceil(jobsTotal / PAGE))}</span>
              <button className="refine-toggle" disabled={(jobPage + 1) * PAGE >= jobsTotal} onClick={() => setJobPageAndLoad(jobPage + 1)}>Next →</button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
