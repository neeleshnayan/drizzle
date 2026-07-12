/**
 * Vision document reading — for the résumé layouts the glyph-position text pass
 * (parse.ts) fights: multi-column and heavily-designed PDFs, where dates and
 * locations otherwise fly away from their entries. A vision/OCR model reads the
 * document and returns clean Markdown, which the existing VALIDATED resume
 * extractor then structures (document → text, NOT document → schema — so the
 * extraction contract isn't re-validated and the intermediate Markdown stays
 * human-inspectable).
 *
 * TWO providers, no rendering on the cloud:
 *   • ollama (local dev)  — render pages to PNGs, transcribe each (needs a GPU).
 *   • openrouter (prod/CF) — send the PDF BYTES straight to OpenRouter's
 *     file-parser (mistral-ocr) → gpt-4o-mini. No canvas/native render, so it
 *     runs on a Cloudflare Worker, and it's off the rate-limited CF Workers-AI
 *     neuron cap entirely.
 *
 * Opt-in via RESUME_PARSE=vision. parse.ts calls this only when the cheap text
 * pass comes back thin, so a normal PDF never pays for OCR.
 */
const BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const VISION_MODEL = process.env.RESUME_VISION_MODEL ?? "llama3.2-vision";
// localhost → ollama; Cloudflare → openrouter. Explicit RESUME_VISION_PROVIDER wins.
const VISION_PROVIDER = (process.env.RESUME_VISION_PROVIDER ?? (process.env.DEPLOY_TARGET === "cloudflare" ? "openrouter" : "ollama")).toLowerCase();

/** Whether the vision parse path is enabled. */
export const VISION_PARSE_ON = (process.env.RESUME_PARSE ?? "").toLowerCase() === "vision";

const TRANSCRIBE_PROMPT =
  "You are a precise document transcriber. Transcribe this résumé/CV to clean Markdown, EXACTLY as written — every name, company, job title, date, location, bullet point, and skill. Preserve the reading order and structure (section headings, entries, bullet lists). For multi-column layouts, keep each entry's dates and location WITH that entry, never in a separate block. Do NOT summarize, infer, reword, add, or omit anything. Output only the Markdown transcription, no commentary.";

/** Render each PDF page to a base64 PNG. scale=2 keeps small text legible.
 *  Node-only (native canvas); never reached on CF (openrouter path renders nothing). */
async function renderPdfToImages(buffer: Buffer): Promise<string[]> {
  const { pdf } = await import("pdf-to-img");
  const doc = await pdf(buffer, { scale: 2 });
  const images: string[] = [];
  for await (const page of doc) {
    images.push(page.toString("base64"));
  }
  return images;
}

/**
 * Cloud path: hand the raw PDF to OpenRouter and let its file-parser OCR it, then
 * gpt-4o-mini transcribes to clean Markdown per our prompt. No rendering — the
 * bytes go up as a `file` content part, so this works on a Worker. Engine
 * defaults to mistral-ocr (real OCR, ~$1-2/1k pages — handles designed/scanned
 * layouts); set OPENROUTER_PDF_ENGINE=pdf-text for the free text-layer engine.
 */
async function transcribePdfViaOpenRouter(buffer: Buffer): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set for vision");
  const model = process.env.OPENROUTER_VISION_MODEL ?? "openai/gpt-4o-mini";
  const engine = process.env.OPENROUTER_PDF_ENGINE ?? "mistral-ocr";
  const dataUrl = `data:application/pdf;base64,${buffer.toString("base64")}`;
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(process.env.OPENROUTER_APP_URL ? { "HTTP-Referer": process.env.OPENROUTER_APP_URL } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: TRANSCRIBE_PROMPT },
            { type: "file", file: { filename: "resume.pdf", file_data: dataUrl } },
          ],
        },
      ],
      plugins: [{ id: "file-parser", pdf: { engine } }],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter vision ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (j.choices?.[0]?.message?.content ?? "").trim();
}

/** Local path: one Ollama vision call per rendered page → the page's Markdown. */
async function transcribeViaOllama(imagesBase64: string[]): Promise<string> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: VISION_MODEL,
      stream: false,
      keep_alive: "1m", // stay warm across a multi-page résumé, then auto-unload
      think: false, // transcription, not reasoning — default-think would pollute output + add latency
      options: { temperature: 0, num_ctx: 8192 },
      messages: [{ role: "user", content: TRANSCRIBE_PROMPT, images: imagesBase64 }],
    }),
  });
  if (!res.ok) throw new Error(`vision transcribe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { message?: { content?: string } };
  return (j.message?.content ?? "").trim();
}

/** Read a résumé PDF to one Markdown string. Cloud → PDF bytes to OpenRouter (no
 *  render); local → render pages and transcribe each with Ollama. */
export async function visionParsePdf(buffer: Buffer): Promise<string> {
  if (VISION_PROVIDER === "openrouter") return transcribePdfViaOpenRouter(buffer);
  const images = await renderPdfToImages(buffer);
  const pages: string[] = [];
  for (const img of images) {
    pages.push(await transcribeViaOllama([img]));
  }
  return pages.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}
