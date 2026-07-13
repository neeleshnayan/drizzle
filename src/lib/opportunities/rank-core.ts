/**
 * RANKING CORE — the pure, runtime-agnostic heart of recommendations.
 *
 * Given the inputs gathered by the get_ranking_inputs RPC (profile + résumé
 * facts + the candidate pool, each pool row carrying a `trajDist` cosine
 * distance computed in Postgres), produce ranked, explained matches. NO I/O,
 * NO node built-ins, NO `@/db`, NO embedding calls — every runtime dependency
 * here is pure arithmetic/string work. That's what lets BOTH run it:
 *   • Node (src/lib/opportunities/recommend.ts) for local dev + the harnesses
 *   • Deno (supabase/functions/rank) so the ranking CPU runs where the data
 *     lives, off the Cloudflare Worker (which only fetches the result)
 *
 * The scoring VECTOR and the direction TRAJECTORY are computed upstream (the
 * scoring vector is cached on the profile; trajDist is pgvector in-DB). This
 * module never reaches for them — it consumes what it's given, so it can't
 * hang, can't need localhost, and produces identical output in either runtime.
 */
import { scoreMatch } from "./match";
import { blendCore, relevanceDamp } from "./blend";
import { hardGate, deriveCandidateQuals, DEGREES, type CandidateQuals } from "./gates";
import { canonSkillKey } from "../skills/canon";
import { inferCurrency, inferCountry } from "../format/comp";
import { toUSD, fmtMoney } from "../format/currency";
import { firstCityHit } from "../geo/canon";
import type { ScoringVector } from "../scoring/schema";
import type { Preferences } from "../preferences";
import type { OpportunityVector, OpportunityFacts } from "./schema";

// ---- shapes returned by the get_ranking_inputs RPC ----
export type RpcPoolRow = {
  id: string; title: string | null; company: string | null; location: string | null;
  remote: string | null; compMin: number | null; compMax: number | null;
  domain: string | null; url: string | null; source: string | null;
  vector: unknown; facts: unknown; rawText: string | null; trajDist: number | null;
};
export type RpcInputs = {
  profile: { id: string; scoring: Record<string, unknown> | null; scoringStale: boolean | null; preferences: Preferences | null; aboutOverrides: unknown } | null;
  experiences: { startDate: string | null }[];
  education: { degree: string | null }[];
  certifications: { name: string | null; issuer: string | null }[];
  skills: string[];
  themes: ({ kind?: string; role?: string; pending?: boolean } | null)[];
  insights: { dimension: string; content: string | null }[];
  signals: { kind: string; vector: unknown }[];
  dismissed: string[];
  pool: RpcPoolRow[];
};

export type RankedJob = {
  id: string;
  title: string | null;
  company: string | null;
  location: string | null;
  country: string | null;
  remote: string | null;
  compMin: number | null;
  compMax: number | null;
  compCurrency: string | null;
  minYears: number | null;
  domain: string | null;
  url: string | null;
  source: string | null;
  summary: string;
  coreRequirements: string[];
  skills: string[];
  fit: number;
  qualification: number;
  desire: number;
  evidence: number | null;
  trajectory: number | null;
  novelty: number;
  building: number;
  peopleLeadership: number;
  reasons: string[];
  gaps: string[];
  why: string;
};

export type RankOutcome = {
  matches: RankedJob[];
  learning: { active: boolean; events: number; confidence: number };
  /** the user's skills as canonical keys — so callers (the skill radar) need
   *  no extra DB round-trips */
  userSkillKeys: string[];
};

// ================= Layer 2: learned drift (was in ./learn) =================
// how loudly each action speaks (impressions are too passive to train on yet)
const EVENT_WEIGHT: Record<string, number> = {
  applied: 1.0,
  up: 0.75,
  apply_click: 0.5,
  down: -0.75,
  dismiss: -0.8,
};
// user-axis ↔ role-axis pairs — the same pairing scoreMatch ranks desire on
const AXIS_PAIRS: [keyof ScoringVector, keyof OpportunityVector][] = [
  ["builder_energy", "off_building"],
  ["people_energy", "off_people_leadership"],
  ["autonomy_need", "off_autonomy"],
  ["impact_drive", "off_impact"],
  ["risk_tolerance", "off_company_risk"],
  ["growth_vs_stability", "off_growth"],
  ["pivot_appetite", "off_domain_novelty"],
];
export type LearnedDrift = {
  deltas: Partial<Record<keyof ScoringVector, number>>;
  confidence: number;
  events: number;
};
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// cosine → the 0.5–1 trajectory band. Calibrated for bge-m3 (the model both the
// pool's embedding_bge and the direction vector now use). bge cosines sit LOWER
// and tighter than nomic — pooled across 10 directions × the pool (2026-07-13,
// tools/bge-calibrate): p50≈0.415, p90≈0.485, p99≈0.566. LO=p50 (off-direction
// floors at 0.5). HI=0.68 = the real TOP-match ceiling: per-direction maxes reach
// 0.66–0.70 (a direction matching its own family — e.g. PM→PM=0.663), so pooled
// p99 (0.566) as HI would saturate the whole genuine leaderboard (0.57–0.70) to
// 1.0 and lose all separation among the best roles (the anchor career_changer
// PM-vs-sales tie caught this). Linear across [0.41, 0.68] keeps off-direction at
// 0.5, the mid-tier lifted, and the leaders spread. (The OLD nomic 0.62/0.80 here
// flattened EVERY bge trajectory to 0.5.) Inlined so rank-core stays free of any
// env-reading module — the Deno ranker imports this tree. Re-run bge-calibrate +
// anchors after any embed change.
const COS_LO = 0.41;
const COS_HI = 0.68;
/** cosine similarity → trajectory score. Below the floor reads 0.5 (a miss
 *  dents, never buries), dead-on reads ~1.0. */
export function trajectoryFromCosine(cos: number): number {
  return 0.5 + 0.5 * clamp01((cos - COS_LO) / (COS_HI - COS_LO));
}

/** the signal kinds that train drift — exported so learnDrift's query filters
 *  on exactly the kinds distillSignals weights (one source of truth) */
export const SIGNAL_KINDS = Object.keys(EVENT_WEIGHT);

/** Pure math: signal rows → drift. */
export function distillSignals(rows: { kind: string; vector: unknown }[]): LearnedDrift | null {
  if (!rows.length) return null;
  let totalWeight = 0;
  const sums: Record<string, number> = {};
  for (const r of rows) {
    const w = EVENT_WEIGHT[r.kind] ?? 0;
    if (!w) continue;
    const v = (r.vector ?? {}) as OpportunityVector;
    totalWeight += Math.abs(w);
    for (const [, roleAxis] of AXIS_PAIRS) {
      const score = (v[roleAxis] as { score?: number } | undefined)?.score ?? 0.5;
      sums[roleAxis] = (sums[roleAxis] ?? 0) + w * (score - 0.5);
    }
  }
  if (totalWeight === 0) return null;
  const confidence = Math.min(1, totalWeight / 6);
  const deltas: LearnedDrift["deltas"] = {};
  for (const [userAxis, roleAxis] of AXIS_PAIRS) {
    const direction = (sums[roleAxis] ?? 0) / totalWeight;
    const d = 0.3 * direction * confidence;
    if (Math.abs(d) > 0.005) deltas[userAxis] = d;
  }
  return { deltas, confidence, events: rows.length };
}

/** Apply a drift to a COPY of the scoring vector. */
export function applyDrift(vec: ScoringVector, drift: LearnedDrift | null): ScoringVector {
  if (!drift || !Object.keys(drift.deltas).length) return vec;
  const out = { ...vec } as Record<string, { score: number; rationale?: string }>;
  for (const [axis, delta] of Object.entries(drift.deltas)) {
    const cur = out[axis];
    if (!cur || typeof cur.score !== "number") continue;
    out[axis] = { ...cur, score: clamp01(cur.score + (delta as number)) };
  }
  return out as unknown as ScoringVector;
}

// ============ hard-qual overrides (was in ../profile/about) ============
type AboutOverrides = { yearsExperience?: number; highestDegree?: string } | null;
/** Apply any facts the user pinned on the About page over the derived quals. */
export function applyQualOverrides(derived: CandidateQuals, o: AboutOverrides): CandidateQuals {
  if (!o) return derived;
  let credentials = derived.credentials;
  if (o.highestDegree !== undefined) {
    credentials = new Set([...derived.credentials].filter((c) => !(DEGREES as readonly string[]).includes(c)));
    if (o.highestDegree !== "none") credentials.add(o.highestDegree as never);
  }
  return { yearsExperience: o.yearsExperience ?? derived.yearsExperience, credentials };
}

// ================= evidence / trajectory / refinements =================
const normSkill = (s: unknown) => canonSkillKey(String(s ?? ""));

function skillEvidence(mine: string[], must: string[], nice: string[]) {
  const have = (s: string) => mine.some((m) => m === s || m.includes(s) || s.includes(m));
  const mustHave = must.filter(have);
  const niceHave = nice.filter(have);
  const mustHit = must.length ? mustHave.length / must.length : null;
  const niceHit = nice.length ? niceHave.length / nice.length : null;
  if (mustHit === null && niceHit === null) return { evidence: null as number | null, missing: [] as string[], proven: 0, of: 0 };
  const evidence = mustHit !== null ? 0.35 + 0.55 * mustHit + 0.1 * (niceHit ?? mustHit) : 0.5 + 0.5 * (niceHit as number);
  return { evidence, missing: must.filter((s) => !have(s)), proven: mustHave.length, of: must.length };
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "who", "how", "their", "more", "than", "over", "across", "from", "into", "being", "want", "wants", "them", "they", "what", "when", "where", "will", "work"]);
const contentWords = (t: string) =>
  t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w));
function trajectoryFit(roleText: string, targetWords: string[], aspireWords: string[]): { score: number | null; targetHit: number } {
  const targetHit = targetWords.length ? targetWords.filter((w) => roleText.includes(w)).length / targetWords.length : 0;
  if (!targetWords.length && !aspireWords.length) return { score: null, targetHit: 0 };
  const aspireHits = aspireWords.filter((w) => roleText.includes(w)).length;
  const aspire = aspireWords.length ? Math.min(1, aspireHits / 4) : null;
  const combined =
    targetWords.length && aspire !== null ? 0.7 * targetHit + 0.3 * aspire : targetWords.length ? targetHit : (aspire as number);
  return { score: 0.5 + 0.5 * combined, targetHit };
}

function compRefine(pref: Preferences, compMin: number | null, compMax: number | null, jobCurrency: string | null) {
  const exp = pref.expectedComp;
  if (!exp) return { factor: 1 } as { factor: number; reason?: string; gap?: string };
  const userCur = pref.compCurrency ?? "INR";
  const top = compMax ?? compMin;
  if (!top) return { factor: 1 };
  const topUsd = toUSD(top, jobCurrency);
  const expUsd = toUSD(exp, userCur);
  if (topUsd === null || expUsd === null) return { factor: 1 };
  const floorUsd = toUSD(pref.acceptMin ?? pref.currentComp ?? exp * 0.85, userCur) as number;
  if (topUsd >= expUsd) return { factor: 1, reason: `Comp clears your ${fmtMoney(exp, userCur)} target` };
  if (topUsd >= floorUsd) return { factor: 0.95, reason: `Comp inside your acceptable range` };
  const ratio = topUsd / expUsd;
  return { factor: Math.max(0.6, 0.6 + 0.4 * ratio), gap: `Comp below the floor you'd accept` };
}

function locationRefine(pref: Preferences, remote: string | null, location: string | null) {
  let factor = 1;
  let reason: string | undefined;
  let gap: string | undefined;
  const want = pref.remote;
  const isRemote = remote === "remote";
  if (want && want !== "any" && remote && remote !== "unknown") {
    if (want === "remote" && !isRemote) {
      factor *= 0.7;
      gap = "Not remote — you wanted remote";
    } else if (want === "onsite" && isRemote) {
      factor *= 0.92;
    } else if (isRemote || want === remote) {
      reason = isRemote ? "Remote" : `${remote[0].toUpperCase()}${remote.slice(1)}`;
    }
  }
  const dreamHit = firstCityHit(location, pref.dreamCities);
  if (dreamHit) {
    factor *= 1.12;
    reason = `✨ ${dreamHit} — your dream city`;
  } else if (pref.locations?.length && !isRemote && location) {
    const hit = firstCityHit(location, pref.locations);
    if (hit) reason = reason ?? `In ${hit}`;
    else return { factor, reason, gap, exclude: true as const };
  }
  return { factor, reason, gap, exclude: false as const };
}

function whySummary(m: { fit: number; reasons: string[]; gaps: string[] }): string {
  const pct = Math.round(m.fit * 100);
  if (m.reasons.length) {
    const r = m.reasons.slice(0, 2).join(", and ").toLowerCase();
    return `${pct}% fit — ${r}${m.gaps.length ? `. Watch: ${m.gaps[0].toLowerCase()}` : ""}.`;
  }
  return `${pct}% fit for where you are right now.`;
}

/**
 * The blend. `inputs` from the RPC; `base` the resolved scoring vector (caller
 * handles the cache/recompute decision — this is pure). Each pool row's
 * `trajDist` is the pgvector cosine distance to the direction (null = no
 * direction, or role has no vector → lexical trajectory fallback).
 */
export function rankFromInputs(inputs: RpcInputs, base: ScoringVector): RankOutcome {
  const me = inputs.profile;
  const drift: LearnedDrift | null = me ? distillSignals(inputs.signals ?? []) : null;
  const vec = applyDrift(base, drift);
  const quals = applyQualOverrides(
    deriveCandidateQuals({ experiences: inputs.experiences ?? [], education: inputs.education ?? [], certifications: inputs.certifications ?? [] }),
    (me?.aboutOverrides ?? null) as AboutOverrides,
  );
  const targetRole: string = (inputs.themes ?? []).find((a) => a?.kind === "target_role" && a.role && !a.pending)?.role ?? "";
  const aspireSents: string[] = (inputs.insights ?? [])
    .filter((r) => r.dimension === "aspiration" || r.dimension === "value")
    .slice(0, 3)
    .map((r) => r.content ?? "")
    .filter(Boolean);
  const targetWords = targetRole ? targetRole.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2) : [];
  const aspireWords = [...new Set(aspireSents.slice(0, 2).flatMap((s) => contentWords(s)))];
  const mySkills: string[] = (inputs.skills ?? []).map((s) => normSkill(s)).filter(Boolean);
  const pref: Preferences = (me?.preferences ?? {}) as Preferences;

  const dismissed = new Set(inputs.dismissed ?? []);
  const undismissed = (inputs.pool ?? []).filter((r) => !dismissed.has(r.id));
  const real = undismissed.filter((r) => r.source !== "sample");
  const roles = real.length ? real : undismissed;

  const ranked = roles
    .map((r) => {
      const v = (r.vector ?? {}) as OpportunityVector;
      const f = (r.facts ?? {}) as Partial<OpportunityFacts>;
      const gate = hardGate({ facts: f, title: r.title }, quals);
      if (!gate.pass) return null;
      const m = scoreMatch(vec, v);
      const c = compRefine(pref, r.compMin, r.compMax, f.comp_currency ?? inferCurrency(r.location));
      const l = locationRefine(pref, r.remote, r.location);
      if (l.exclude) return null;
      const roleSkills = [...new Set([...(f.must_have_skills ?? []), ...(f.nice_to_have_skills ?? [])].map(normSkill).filter(Boolean))];
      const ev = skillEvidence(mySkills, (f.must_have_skills ?? []).map(normSkill).filter(Boolean), (f.nice_to_have_skills ?? []).map(normSkill).filter(Boolean));
      // trajectory: SEMANTIC when the RPC gave a cosine distance (a direction
      // vector existed); lexical word-overlap otherwise. targetHit stays lexical
      // (for the "you set this with your mentor" reason).
      const roleText = ` ${(r.title ?? "").toLowerCase()} ${(r.domain ?? "").toLowerCase()} ${(f.summary ?? "").toLowerCase()} ${roleSkills.join(" ")} `;
      const trajDist = r.trajDist;
      let traj: { score: number | null; targetHit: number };
      if (trajDist != null) {
        traj = {
          score: trajectoryFromCosine(1 - Number(trajDist)),
          targetHit: targetWords.length ? targetWords.filter((w) => roleText.includes(w)).length / targetWords.length : 0,
        };
      } else {
        traj = trajectoryFit(roleText, targetWords, aspireWords);
      }
      const core = blendCore(m.desire, ev.evidence, traj.score);
      const rel = relevanceDamp(vec.seniority?.score ?? 0.5, ev.evidence, traj.score);
      const fit = Math.min(1, m.gate * core * rel * c.factor * l.factor * (gate.marginal?.penalty ?? 1));
      const reasons = [
        traj.targetHit >= 0.5 ? "The direction you set with your mentor" : null,
        ev.evidence !== null && ev.of > 0 && ev.proven / ev.of >= 0.7 ? `Your résumé shows ${ev.proven} of ${ev.of} required skills` : null,
        c.reason,
        l.reason,
        ...m.reasons,
      ].filter(Boolean) as string[];
      const gaps = [
        gate.marginal?.gap,
        ev.evidence !== null && ev.of > 0 && ev.proven / ev.of < 0.5 && ev.missing.length
          ? `Asks for ${ev.missing.slice(0, 3).join(", ")} — not on your résumé`
          : null,
        c.gap,
        l.gap,
        ...m.gaps,
      ].filter(Boolean) as string[];
      const summary = f.summary?.trim() || (r.rawText ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
      const coreRequirements = f.core_requirements?.length ? f.core_requirements : f.must_have_skills ?? [];
      const out: RankedJob = {
        id: r.id,
        title: r.title,
        company: r.company,
        location: r.location,
        country: inferCountry(r.location) ?? (f.country as string | null) ?? null,
        remote: r.remote,
        compMin: r.compMin,
        compMax: r.compMax,
        compCurrency: f.comp_currency ?? null,
        minYears: f.min_years_experience ?? null,
        domain: r.domain,
        url: r.url,
        source: r.source,
        summary,
        coreRequirements,
        skills: roleSkills,
        fit,
        qualification: m.qualification,
        desire: m.desire,
        evidence: ev.evidence,
        trajectory: traj.score,
        novelty: v.off_domain_novelty?.score ?? 0.3,
        building: v.off_building?.score ?? 0.5,
        peopleLeadership: v.off_people_leadership?.score ?? 0.3,
        reasons,
        gaps,
        why: whySummary({ fit, reasons, gaps }),
      };
      return out;
    })
    .filter((j): j is RankedJob => j !== null)
    .sort((a, b) => b.fit - a.fit);

  // Diversity guard: cap each company at 2 head-of-list slots; overflow keeps
  // its rank order afterwards — nothing hidden, just interleaved.
  const head: RankedJob[] = [];
  const tail: RankedJob[] = [];
  const perCompany = new Map<string, number>();
  for (const j of ranked) {
    const n = perCompany.get(j.company ?? "?") ?? 0;
    if (n < 2) { head.push(j); perCompany.set(j.company ?? "?", n + 1); }
    else tail.push(j);
  }
  return {
    matches: [...head, ...tail],
    learning: { active: !!drift && drift.confidence > 0, events: drift?.events ?? 0, confidence: drift?.confidence ?? 0 },
    userSkillKeys: mySkills,
  };
}
