/**
 * B2 — live recommendation seam. When the user expresses a DIRECTION to explore
 * ("I'm curious about marketing", "thinking about product"), pull real, current
 * roles in that space that fit them — fed into the mentor's turn (so it speaks
 * about actual openings) AND surfaced as dive-able cards. Deterministic (no LLM
 * in the hot path); swappable for an LLM tool-call once the brain is Claude.
 */
import { sql } from "drizzle-orm";
import { withScopedDb } from "@/db";
import { embedBge } from "@/lib/embeddings";
import { rankMatches } from "./recommend";

export type DirectionRole = { kind: string; title: string; company: string; why: string };
export type DirectionRecs = { direction: string; roles: DirectionRole[]; brief: string };

// canonical direction → keyword matcher (title/domain/summary/skills)
const DOMAINS: { label: string; kw: RegExp }[] = [
  { label: "marketing", kw: /market(ing)?|brand|demand gen|growth marketing|content strategist|communications/i },
  { label: "product management", kw: /product manage|product owner|\bPM\b|product lead|head of product/i },
  { label: "design", kw: /\bdesign(er)?\b|\bUX\b|\bUI\b|user experience|product design/i },
  { label: "data & AI", kw: /\bdata\b|analytics|data scien|machine learning|\bML\b|\bAI\b|\bMLE\b/i },
  { label: "engineering", kw: /engineer|software|developer|backend|frontend|full.?stack|platform|infra/i },
  { label: "sales", kw: /\bsales\b|account exec|business develop|\bBD\b|revenue|account manager/i },
  { label: "finance", kw: /financ|accounting|\bFP&A\b|investment|controller|treasury/i },
  { label: "operations", kw: /operations|\bops\b|program manage|chief of staff|supply chain/i },
  { label: "founding / startups", kw: /found(er|ing)|start.?up|entrepreneur|my own (thing|company|venture)|build my own/i },
  { label: "consulting", kw: /consult(ing|ant)|strategy|advisory/i },
];

// phrasing that signals a wish to explore a direction (vs just mentioning a word)
const INTENT =
  /\b(explore|explor\w+|move into|moving into|pivot(ing)? (to|into)|curious about|thinking about|think about|get into|getting into|transition\w*|shift\w*|interested in|what about|break into|switch to|go into|lean into|try(ing)? out)\b/i;

/** Pure: which direction (if any) is the user expressing a wish to explore? */
export function detectDirection(text: string): string | null {
  if (!text || text.trim().length < 8) return null;
  if (!INTENT.test(text)) return null; // require explore-intent, else too noisy
  const hit = DOMAINS.find((d) => d.kw.test(text));
  return hit?.label ?? null;
}

/** Pull the top real roles that fit the user in an EXPLICIT direction (no intent
 *  gate) — used by the Deepgram `fetch_recommendations` function call. */
export async function recsForDirection(userId: string, direction: string): Promise<DirectionRole[]> {
  const d = direction?.trim();
  if (!d) return [];

  // SEMANTIC pull: embed the direction with bge-m3 (same space as the pool's
  // embedding_bge — OpenRouter on CF, local ollama in dev) and take the roles
  // NEAREST to it in vector space. This is the "really aligned" recommendation —
  // it finds roles that MEAN "marketing", not just ones with the word in them.
  try {
    const [vec] = await embedBge([d]);
    if (vec?.length) {
      const lit = `[${vec.join(",")}]`;
      const res = await withScopedDb((db) =>
        db.execute(sql`
          SELECT title, company, domain, facts->>'summary' AS summary
          FROM opportunities
          WHERE embedding_bge IS NOT NULL AND visibility = 'global' AND title IS NOT NULL
          ORDER BY embedding_bge <=> ${lit}::vector
          LIMIT 16
        `),
      );
      const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as {
        title: string; company: string | null; domain: string | null; summary: string | null;
      }[];
      // the pool has repeat postings — dedup by title+company, keep the nearest, cap at 4
      const seen = new Set<string>();
      const uniq = rows.filter((r) => {
        const k = `${r.title}|${r.company ?? ""}`.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, 4);
      if (uniq.length) {
        return uniq.map((r) => ({
          kind: "A DIFFERENT PATH",
          title: r.title,
          company: r.company ?? "",
          why: r.domain ? `${r.domain} — a strong ${d} fit` : `a strong ${d} fit`,
        }));
      }
    }
  } catch {
    /* bge unavailable → fall through to the keyword approach below */
  }

  // fallback: keyword-filter the user's ranked matches (the previous behaviour)
  const dl = d.toLowerCase();
  const dom = DOMAINS.find((x) => x.label === dl) ?? DOMAINS.find((x) => x.kw.test(dl));
  const kw =
    dom?.kw ??
    new RegExp(
      dl.split(/\s+/).filter((w) => w.length > 2).map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean).join("|") || "\\b\\B",
      "i",
    );
  const ranked = await rankMatches(userId).catch(() => []);
  return ranked
    .filter((j) => kw.test(`${j.title ?? ""} ${j.domain ?? ""} ${j.summary ?? ""} ${(j.skills ?? []).join(" ")}`))
    .slice(0, 4)
    .map((j) => ({ kind: "A DIFFERENT PATH", title: j.title ?? "a role", company: j.company ?? "", why: j.why }));
}

/** Detect a direction + pull the top real roles in it that fit the user. */
export async function detectDirectionRecs(userId: string, text: string): Promise<DirectionRecs | null> {
  const direction = detectDirection(text);
  if (!direction) return null;
  const dom = DOMAINS.find((d) => d.label === direction);
  if (!dom) return null;

  const ranked = await rankMatches(userId).catch(() => []);
  if (!ranked.length) return null;

  const matching = ranked
    .filter((j) => dom.kw.test(`${j.title ?? ""} ${j.domain ?? ""} ${j.summary ?? ""} ${(j.skills ?? []).join(" ")}`))
    .slice(0, 3);
  if (!matching.length) return null;

  const roles: DirectionRole[] = matching.map((j) => ({
    kind: "A DIFFERENT PATH",
    title: j.title ?? "a role",
    company: j.company ?? "",
    why: j.why,
  }));
  const brief =
    `\n\nLIVE BRIEF — they just expressed interest in exploring ${direction}. Here are REAL, current roles in that space that actually fit them. Weave them in as their mentor — offer them as concrete directions to consider, never read them as a list:\n` +
    matching.map((j) => `- ${j.title} at ${j.company} — ${j.why}`).join("\n");

  return { direction, roles, brief };
}
