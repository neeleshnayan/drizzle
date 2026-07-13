/**
 * The ONE tiered-vectorisation core, shared by the CLI (tools/tiered-revectorize.ts)
 * and the admin dashboard (runInference) so the two can never drift.
 *
 * Strategy: a cheap-fast model (granite) handles the bulk in ~5s; a row is
 * ESCALATED to the strong model (gemma3) when the fast extraction is thin
 * (skills scrubbed to <2), has no real summary, OR the fast model itself flagged
 * the JD as hard (needs_review). The escalation is deliberately OR'd so an
 * overconfident self-report can't hide an objectively thin extraction, and a
 * grounded self-flag catches wrong-but-present output the heuristics miss.
 *
 * Pure functions of the DB + the LLM provider — callers own batching, cooldowns,
 * progress, and the model-resident order (all-fast then all-strong = one swap).
 */
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { opportunities } from "@/db/schema";
import { getProvider } from "@/llm";
import { VECTORIZE_PROMPT, VECTORIZE_PROMPT_VERSION, vectorizeJsonSchema } from "@/agents/opportunity-vectorizer";
import { opportunityExtraction, type OpportunityExtraction, type OpportunityFacts } from "@/lib/opportunities/schema";
import { sanitize } from "@/agents/jd-keywords";

// granite4.1:8b was DEMOTED after a vector-flatness audit (2026-07-10): its
// facts were fine but 93% of its 0-1 axis scores landed in [0.55,0.65], 90% of
// rows had near-zero spread, and 5 of 12 axes were dead (req_seniority 0.60
// ±0.017 — the same score for intern and CTO). Ranking runs on the vector, so a
// model that won't commit to a judgment is useless here no matter how fast.
// gemma3 runs end to end (~27s/JD); the tiered seam stays so a future small
// model that PASSES the flatness audit (tools/vector-flatness.ts) can slot back
// into FAST via env without touching code.
// gemma4:26b — bakeoff-validated ~= gemma3:27b quality at ~3x speed (~10s/role
// vs ~31s). Switched the crunch to it; gemma3:27b stays TRUSTED below so the
// existing (gemma3-stamped) pool keeps ranking while we re-crunch to gemma4.
export const FAST_MODEL = process.env.VECTORIZE_FAST_MODEL ?? "gemma4:26b";
export const STRONG_MODEL = process.env.VECTORIZE_STRONG_MODEL ?? "gemma4:26b";
/** Models whose stored vectors we currently trust — the backfill redoes any row
 *  stamped by a model NOT in this set (e.g. every granite-era row). gemma3:27b is
 *  kept here through the gemma3→gemma4 transition so the current pool still ranks;
 *  drop it (this constant → just FAST/STRONG) once every row is re-crunched on
 *  gemma4 (force-backfill the whole pool — now practical at 3x speed). */
export const LEGACY_TRUSTED = ["gemma3:27b"];
export const TRUSTED_MODELS = [...new Set([FAST_MODEL, STRONG_MODEL, ...LEGACY_TRUSTED])];
/** integer-column guard: round decimals, drop NaN/±Inf/null → null */
const toInt = (v: unknown): number | null => {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? null : Math.round(n);
};
const CTX = Number(process.env.OLLAMA_VECTORIZE_NUM_CTX ?? 16384);
const JD_CHARS = Number(process.env.OLLAMA_VECTORIZE_JD_CHARS ?? 16000);

// schema is pure (no env) → memoize; provider is resolved LAZILY so the CLI can
// set LLM_PROVIDER_VECTORIZE before the first call without an import-order race.
const schema = vectorizeJsonSchema();

/** Run the production extraction on one JD. `model` undefined → provider default. */
export async function extractRole(jd: string, model?: string): Promise<OpportunityExtraction> {
  const res = await getProvider("vectorize").extractStructured({
    schemaName: "vectorize_role",
    jsonSchema: schema,
    prompt: VECTORIZE_PROMPT + (jd ?? "").slice(0, JD_CHARS),
    numCtx: CTX,
    maxTokens: 4500,
    ...(model ? { model } : {}),
    keepAlive: "15m",
  });
  const out = opportunityExtraction.parse(res.data);
  reconcileTechDepth(out);
  return out;
}

// gemma's req_technical_depth SCORE has a stuck upward prior: any role at a
// tech company or with tech-flavored language (AI/SQL/data/automation) comes back
// 0.6–0.85 no matter how explicitly the rubric bands it lower. Two prompt
// sharpenings (v4, v5) moved it ZERO, so the fix is a deterministic consistency
// guard rather than more prose. Design (learned from holdout tests that caught
// finance/accounting/AE/PM gaps):
//   BUILD   — genuine engineering. Checked FIRST → NEVER capped, even at a
//             marketing company. A Software/ML/Security/Data/Infra Engineer or
//             SRE is technical regardless of what the org sells.
//   NONTECH — the open-ended set of non-building functions (GTM, legal, finance,
//             accounting, ops, PM, HR, design…). Matched on title OR domain.
//   ENG_NOUN — an engineer/developer/architect noun sitting inside a NONTECH
//             function ("Sales Engineer", "GTM Engineer") = the rubric's
//             technical-ADJACENT band → 0.6 ceiling; everything else → 0.35.
// Deliberately NO tech-flavor exemption: "AI Native" in a sales title or "AI
// sales" as a domain must NOT rescue a salesperson (that was the v5.0 bug).
const BUILD = /\b(software|backend|frontend|full.?stack|infrastructure|infra|platform engineer|systems engineer|embedded|firmware|compiler|devops|\bSRE\b|site reliability|security engineer|reliability engineer|ML engineer|machine learning engineer|data engineer|research engineer|robotics|hardware engineer)\b/i;
// NOTE: intentionally NO trailing \b on the group — these are PREFIXES (market→
// marketing, financ→financial, recruit→recruiter, complian→compliance). Short
// ambiguous tokens carry their own \b…\b (sales, HR, support) to avoid
// over-matching (Salesforce, supporting-cast prose).
const NONTECH = /\b(?:market|brand|content|communicat|sales\b|account exec|account manager|business develop|partnership|revenue|customer success|customer support|\bsupport\b|recruit|talent|people ops|human resources|\bHR\b|legal|counsel|attorney|paralegal|complian|privacy|financ|accounting|accountant|controller|payroll|bookkeep|procurement|operations|program manager|project manager|chief of staff|workplace|facilities|office manager|copywrit|community|creative|design)/i;
const ENG_NOUN = /\b(engineer|developer|architect)\b/i;
export function reconcileTechDepth(out: OpportunityExtraction): void {
  const td = out.vector.req_technical_depth;
  if (!td || typeof td.score !== "number") return;
  const title = out.facts.title ?? "";
  const domain = out.facts.domain ?? "";
  // real engineering wins outright — never capped, AND never left absurdly
  // under-scored: gemma occasionally flakes a full-stack/ML/security engineer
  // low (observed: Software Engineer, Full Stack @ 0.35), which would wrongly
  // drop the role's bar and let a non-technical candidate clear it. Floor it into
  // the rubric's build band. (Checked on the TITLE — domain can be the company's
  // industry, e.g. "fintech".)
  if (BUILD.test(title)) {
    if (td.score < 0.6) {
      td.rationale = `${td.rationale ? td.rationale + " · " : ""}floored ${td.score}→0.6: title "${title.slice(0, 38)}" is real engineering`;
      td.score = 0.6;
    }
    return;
  }
  // non-technical function? title is authoritative; domain corroborates but a
  // BUILD-flavored domain ("AI infra") is not a non-tech signal
  const nonTechTitle = NONTECH.test(title);
  const nonTechDomain = domain !== "" && NONTECH.test(domain) && !BUILD.test(domain);
  if (!nonTechTitle && !nonTechDomain) return; // ambiguous (analyst/strategist/PM-less) → trust gemma
  // engineer/architect NOUN inside a non-tech function = technical-adjacent (0.6);
  // otherwise the rubric floor for GTM/legal/finance/ops (0.35)
  const cap = ENG_NOUN.test(title) ? 0.6 : 0.35;
  if (td.score <= cap) return;
  td.rationale = `${td.rationale ? td.rationale + " · " : ""}capped ${td.score}→${cap}: ${nonTechTitle ? `title "${title.slice(0, 38)}"` : `domain "${domain}"`} is non-technical`;
  td.score = cap;
}

/** Scrub skills IN PLACE (drops sentences/traits/degrees/duration, 55-char cap)
 *  and return the surviving must-skill count. */
export function cleanSkills(facts: OpportunityFacts): number {
  const must = sanitize(facts.must_have_skills ?? [], 55);
  facts.must_have_skills = must;
  facts.nice_to_have_skills = sanitize(facts.nice_to_have_skills ?? [], 55);
  return must.length;
}

/** Why the strong model should redo this extraction — null when the fast one is
 *  good enough. Also scrubs skills in place (so a kept row writes the clean set).
 *  The self-flag only escalates when a DIFFERENT model would retry: when
 *  fast === strong, re-asking the same model about the same vague JD produces
 *  the same answer — under prompt v2 that self-flag loop escalated nearly every
 *  row to itself and stalled a whole sweep. The flag is still WRITTEN to facts
 *  either way (it's honest metadata), it just doesn't trigger a redo. */
export function escalationReason(facts: OpportunityFacts): string | null {
  const clean = cleanSkills(facts);
  if (clean < 2) return `${clean} clean skills`;
  if ((facts.summary?.trim().length ?? 0) <= 20) return "thin summary";
  if (facts.needs_review === true && FAST_MODEL !== STRONG_MODEL) {
    return `self-flagged: ${facts.review_reason || "hard JD"}`;
  }
  return null;
}

export type RowMeta = { title: string | null; company: string | null; location: string | null; source: string | null };

/** Board rows: the ATS's own header fields are authoritative; bookmarks (source
 *  "other") only have placeholder title/company, so the extraction wins there. */
export function applyRowAuthority(out: OpportunityExtraction, row: RowMeta): void {
  if (row.source !== "other") {
    out.facts.title = row.title || out.facts.title;
    out.facts.company = row.company || out.facts.company;
    out.facts.location = row.location ?? out.facts.location;
  } else {
    out.facts.title = out.facts.title || row.title || "";
    out.facts.company = out.facts.company || row.company || "";
  }
  // re-run the consistency guard now that the AUTHORITATIVE title is in place —
  // gemma sometimes emits an empty title/domain (observed live: Brand Designer
  // JD → title "", domain ""), so the in-extractRole pass had nothing to judge.
  // Idempotent: a row already at/below its cap is untouched.
  reconcileTechDepth(out);
}

/** Persist an extraction to its row, stamping the model + prompt version and
 *  clearing the escalation flag. The prompt_v stamp is what lets a future
 *  prompt bump re-queue exactly the stale rows and nothing else. */
export async function writeVectorization(id: string, out: OpportunityExtraction, model: string | null, row: RowMeta): Promise<void> {
  const facts = { ...out.facts, prompt_v: VECTORIZE_PROMPT_VERSION };
  // Trajectory embedding is bge-m3 (embedding_bge), written in ONE local pass
  // after extraction (see fetch.ts) or by tools/bge-backfill — not here. The old
  // inline nomic embed (legacy `embedding` jsonb) is retired: ranking never read
  // it, and embedding between rows evicted the resident extractor (VRAM sawtooth).
  await db
    .update(opportunities)
    .set({
      vector: out.vector,
      facts,
      remote: out.facts.remote ?? undefined,
      // comp_* are integer columns; models occasionally emit a decimal
      // (e.g. gemma4 → "63003.2"), which Postgres rejects. Round to int.
      compMin: toInt(out.facts.comp_min),
      compMax: toInt(out.facts.comp_max),
      companyStage: out.facts.company_stage,
      domain: out.facts.domain || null,
      vectorizedAt: sql`now()`,
      needsStrongPass: false,
      vectorizeModel: model,
      ...(row.source === "other" ? { title: out.facts.title || row.title, company: out.facts.company || row.company } : {}),
    })
    .where(eq(opportunities.id, id));
}

/** Free a model's VRAM (keep_alive:0) — call between the fast and strong passes. */
export async function unloadModel(model: string): Promise<void> {
  const base = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, keep_alive: 0 }),
  }).catch(() => {});
}
