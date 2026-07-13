/**
 * Semantic trajectory via embeddings — turning "who this role is" and "where this
 * person is heading" into comparable vectors, so a Forward-Deployed Engineer role
 * that shares zero words with "architect foundational systems" still reads as
 * on-direction (meaning ≠ spelling).
 *
 * Model: bge-m3 (1024d), run BOTH sides so cosines are comparable — local ollama
 * for bulk pool embedding (free, on the 4090) and the mentor's per-user direction
 * embed in dev; OpenRouter for the per-user direction embed on Cloudflare (no
 * ollama there). bge is SYMMETRIC — no search_query/document prefixes, so callers
 * pass plain text. The cosine→score calibration lives in rank-core
 * (trajectoryFromCosine), inlined there so the Deno Edge ranker can import it
 * without this env-reading module.
 */
const BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const BGE_MODEL = process.env.EMBED_BGE_MODEL ?? "bge-m3"; // ollama tag
const OR_BGE_MODEL = process.env.OPENROUTER_BGE_MODEL ?? "baai/bge-m3"; // OpenRouter slug

/** Batch-embed with bge-m3 → 1024d vectors (the `embedding_bge` column). Cloud
 *  path is OpenRouter (same model as the local pool → comparable cosines, and it
 *  sidesteps CF's Workers-AI neuron cap); local path is ollama. Routes to
 *  OpenRouter on CF (no ollama there) or when EMBED_PROVIDER=openrouter. */
export async function embedBge(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const useOpenRouter = process.env.EMBED_PROVIDER === "openrouter" || process.env.DEPLOY_TARGET === "cloudflare";
  if (useOpenRouter) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OpenRouter bge: OPENROUTER_API_KEY missing");
    const r = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: OR_BGE_MODEL, input: texts }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`openrouter bge ${r.status}: ${(await r.text()).slice(0, 150)}`);
    const j = (await r.json()) as { data: { embedding: number[]; index: number }[] };
    return j.data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding); // preserve input order
  }
  const r = await fetch(`${BASE}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: BGE_MODEL, input: texts }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`bge embed ${r.status}`);
  return ((await r.json()) as { embeddings: number[][] }).embeddings;
}

/** The text that REPRESENTS a role for trajectory matching — what it IS, not its
 *  rubric scores. Title + plain-English summary + skills. Carries a legacy
 *  "search_document:" prefix that bge callers strip (bge is symmetric); kept so
 *  the pool + direction texts stay byte-identical to what's already embedded. */
export function roleEmbedText(facts: { title?: string; summary?: string; must_have_skills?: string[]; domain?: string }, title?: string | null): string {
  const t = title || facts.title || "";
  const skills = (facts.must_have_skills ?? []).slice(0, 10).join(", ");
  return `search_document: ${t}. ${facts.domain ?? ""} ${facts.summary ?? ""} ${skills ? `Skills: ${skills}` : ""}`.replace(/\s+/g, " ").trim();
}

export function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? d / denom : 0;
}
