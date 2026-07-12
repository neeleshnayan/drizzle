/**
 * Hard-requirement GATES — filters, not similarity. A JD that requires a PhD,
 * a bar admission, or 10 years is stating a pass/fail condition; no work-style
 * alignment buys it back. Gates decide whether a role appears; desire decides
 * where it ranks.
 *
 *   credentials  → binary: missing a required degree/license = gated out
 *   years        → wiggle: within 2 years of the ask = shown with an honest
 *                  gap chip + small penalty; beyond that = gated out
 *
 * Facts come from extraction only (rows vectorized before these fields exist
 * simply don't gate — the pool gets re-vectorized once the structure is final).
 */
import type { OpportunityFacts } from "./schema";

// The closed credential set — versatile across verticals but NORMALIZED, so
// gating stays deterministic. Two families:
//   degrees:  phd | md | jd | mba | masters | bachelors | associate
//   licenses: cpa | ca | cfa | frm | cfp | bar | rn | pe | pmp
// (md covers MBBS; jd covers LLB; ca = chartered accountant; bar = admission
// to practice law; rn = nursing licensure; pe = professional engineer.)
export const DEGREES = ["phd", "md", "jd", "mba", "masters", "bachelors", "associate"] as const;
export const LICENSES = ["cpa", "ca", "cfa", "frm", "cfp", "bar", "rn", "pe", "pmp"] as const;
export type Degree = (typeof DEGREES)[number];
export type Credential = Degree | (typeof LICENSES)[number];

export type CandidateQuals = {
  yearsExperience: number | null; // null = résumé has no parseable dates
  credentials: Set<Credential>;
};

export type GateResult =
  | { pass: true; marginal?: { penalty: number; gap: string } }
  | { pass: false; reason: string };

const YEARS_WIGGLE = 2;
const MARGINAL_PENALTY = 0.88; // shown, but honestly demoted

// ---- candidate side (deterministic, from the résumé) ----

/** "June 2019", "2019-06", "Jun 2019", "2019" → year (month ignored — year
 *  precision is plenty for a years-of-experience estimate). */
export function parseYear(s: string | null | undefined): number | null {
  const m = (s ?? "").match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

// degree/license detection from free-text résumé fields. Deliberately broad on
// synonyms (B.Tech/BSc/BE all = bachelors; MBBS = md; LLB = jd) — the résumé is
// the candidate's OWN claim, so recall matters more than precision here.
const DEGREE_PATTERNS: [Credential, RegExp][] = [
  ["phd", /\bph\.?\s?d|doctor(ate|al)\b|\bd\.?phil\b/i],
  ["md", /\bm\.?d\.?\b|doctor of medicine|\bmbbs\b|\bdo\b.{0,20}osteopath/i],
  ["jd", /\bj\.?d\.?\b|juris doctor|\bll\.?[bm]\b|bachelor of law/i],
  ["mba", /\bm\.?b\.?a\b|master of business/i],
  ["masters", /\bmaster|\bm\.?s(c|\b)|\bm\.?tech\b|\bm\.?e(ng)?\b|\bm\.?a\b|\bm\.?com\b|\bm\.?phil\b|post.?graduate/i],
  ["bachelors", /\bbachelor|\bb\.?s(c|\b)|\bb\.?tech\b|\bb\.?e(ng)?\b|\bb\.?a\b|\bb\.?com\b|\bb\.?b\.?a\b|undergrad/i],
  ["associate", /associate('?s)? degree|\ba\.?a\.?s?\b(?=.{0,20}degree)|\bdiploma\b/i],
];
const LICENSE_PATTERNS: [Credential, RegExp][] = [
  ["cpa", /\bcpa\b|certified public accountant/i],
  ["ca", /\bchartered accountant\b|\bicai\b|\bca\b(?=.{0,25}(institute|chartered|india|final))/i],
  ["cfa", /\bcfa\b(?!.{0,20}(level\s*(i|1|ii|2)\b|candidate))|chartered financial analyst/i],
  ["frm", /\bfrm\b|financial risk manager/i],
  ["cfp", /\bcfp\b|certified financial planner/i],
  ["bar", /\bbar (admission|admitted|exam passed|council)\b|admitted to (the )?bar|state bar of/i],
  ["rn", /\bregistered nurse\b|\brn\b(?=.{0,20}(licen|registered|nurse))|nursing licen[cs]e/i],
  ["pe", /\bprofessional engineer\b|\bp\.?e\.? licen[cs]e/i],
  ["pmp", /\bpmp\b|project management professional/i],
];

export function deriveCandidateQuals(input: {
  experiences: { startDate: string | null }[];
  education: { degree: string | null; field?: string | null }[];
  certifications?: { name: string | null; issuer?: string | null }[];
}): CandidateQuals {
  const startYears = input.experiences.map((e) => parseYear(e.startDate)).filter((y): y is number => y !== null);
  const yearsExperience = startYears.length ? Math.max(0, new Date().getFullYear() - Math.min(...startYears)) : null;

  const credentials = new Set<Credential>();
  for (const ed of input.education) {
    const d = ed.degree ?? "";
    for (const [cred, pat] of DEGREE_PATTERNS) if (pat.test(d)) credentials.add(cred);
  }
  // licenses live on the certifications rail of the résumé (CPA, CFA, PMP, bar…)
  for (const cert of input.certifications ?? []) {
    const t = [cert.name, cert.issuer].filter(Boolean).join(" ");
    for (const [cred, pat] of [...LICENSE_PATTERNS, ...DEGREE_PATTERNS]) if (pat.test(t)) credentials.add(cred);
  }
  return { yearsExperience, credentials };
}

// What satisfies a requirement. Degrees: higher ones satisfy lower ones
// (doctorates imply a masters-level bar; any degree implies associate).
// MBA is its own bar — a generic masters doesn't satisfy "MBA required"
// (screens treat it as a distinct credential), but an MBA satisfies "masters".
// Licenses: exact match only — nothing substitutes for a bar admission.
const SATISFIES: Record<Credential, Credential[]> = {
  phd: ["phd"],
  md: ["md"],
  jd: ["jd"],
  mba: ["mba"],
  masters: ["masters", "mba", "phd", "md", "jd"],
  bachelors: ["bachelors", "masters", "mba", "phd", "md", "jd"],
  associate: ["associate", "bachelors", "masters", "mba", "phd", "md", "jd"],
  cpa: ["cpa"],
  ca: ["ca"],
  cfa: ["cfa"],
  frm: ["frm"],
  cfp: ["cfp"],
  bar: ["bar"],
  rn: ["rn"],
  pe: ["pe"],
  pmp: ["pmp"],
};

const REQ_LABEL: Record<Credential, string> = {
  phd: "a PhD",
  md: "an MD",
  jd: "a JD/LLB",
  mba: "an MBA",
  masters: "a master's degree",
  bachelors: "a bachelor's degree",
  associate: "an associate degree",
  cpa: "a CPA",
  ca: "a CA",
  cfa: "a CFA charter",
  frm: "an FRM",
  cfp: "a CFP",
  bar: "bar admission",
  rn: "an RN license",
  pe: "a PE license",
  pmp: "a PMP",
};

// extraction aliases → canonical (the model mostly obeys the enum, but be
// forgiving about common spellings so a near-miss doesn't silently skip a gate)
const ALIASES: Record<string, Credential> = {
  "ph.d": "phd", doctorate: "phd", mbbs: "md", llb: "jd", llm: "jd",
  master: "masters", "master's": "masters", msc: "masters", bachelor: "bachelors",
  "bachelor's": "bachelors", bsc: "bachelors", "bar admission": "bar",
  "registered nurse": "rn", "professional engineer": "pe",
};

// ---- the gate ----

// Seniority reads OFF the title (extraction rarely floors it): an internship or
// trainee posting is written for a student, not someone mid-career; an explicit
// junior/entry/new-grad posting is written well below a senior. Kept tight to
// avoid false gates — "Associate" alone is too ambiguous (Associate PM = entry,
// Associate Partner = senior), so it's excluded.
const INTERNSHIP = /\b(intern|internship|trainee|apprentice(ship)?|co-?op|working student|praktikum|summer analyst)\b/i;
const ENTRY_LEVEL = /\b(entry[ -]?level|junior|jr\.?|new grad(uate)?|grad(uate)? (scheme|programme|program|analyst|trainee)|early[ -]?career)\b/i;

export function hardGate(
  role: { facts: Partial<OpportunityFacts> | null; title?: string | null },
  cand: CandidateQuals,
): GateResult {
  const f = role.facts ?? {};

  // Downward seniority: a role can be too JUNIOR, not just too senior. An
  // internship is a hard miss for anyone with real experience; an entry-level
  // posting for a clearly-senior candidate is a steep demote (they *might*
  // downshift, but it must never read as a strong match).
  const title = role.title ?? f.title ?? "";
  const yrs = cand.yearsExperience;
  if (yrs !== null) {
    if (INTERNSHIP.test(title) && yrs >= 3) {
      return { pass: false, reason: `an internship — you're at ${yrs} yrs` };
    }
    if (ENTRY_LEVEL.test(title) && yrs >= 8) {
      return { pass: true, marginal: { penalty: 0.6, gap: `An entry-level role — well below your ${yrs} yrs` } };
    }
  }

  const requiredCreds = ((f.required_credentials as string[] | undefined) ?? [])
    .map((c) => c.toLowerCase().trim())
    .map((c) => (c in SATISFIES ? (c as Credential) : ALIASES[c]))
    .filter((c): c is Credential => !!c);
  for (const req of requiredCreds) {
    if (!SATISFIES[req].some((c) => cand.credentials.has(c))) {
      return { pass: false, reason: `requires ${REQ_LABEL[req]}` };
    }
  }

  const reqYears = f.min_years_experience ?? null;
  if (reqYears !== null && cand.yearsExperience !== null) {
    const shortfall = reqYears - cand.yearsExperience;
    if (shortfall > YEARS_WIGGLE) return { pass: false, reason: `asks ${reqYears}+ yrs — you're at ${cand.yearsExperience}` };
    if (shortfall > 0) {
      return { pass: true, marginal: { penalty: MARGINAL_PENALTY, gap: `Asks ${reqYears}+ yrs — you're at ${cand.yearsExperience} (close enough to try)` } };
    }
  }
  return { pass: true };
}
