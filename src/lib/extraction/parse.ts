/**
 * File bytes -> plain text. For PDFs we reconstruct *reading order* from glyph
 * positions instead of trusting content-stream order (which scrambles two-column
 * résumé layouts — dates/locations fly away from their entries, later-added
 * entries land at the end). This is the single biggest robustness win before the
 * model ever sees the text.
 */
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import { VISION_PARSE_ON, visionParsePdf } from "./vision";

interface PdfItem {
  str: string;
  x: number;
  y: number;
}

const Y_TOLERANCE = 2; // glyphs within this many units of Y are the same line

async function parsePdfLayout(buffer: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const pages: string[] = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();

    const items: PdfItem[] = [];
    for (const it of content.items as Array<{ str?: string; transform?: number[] }>) {
      if (typeof it.str !== "string" || !it.str.trim() || !Array.isArray(it.transform)) {
        continue;
      }
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5] });
    }

    // top-to-bottom (PDF Y grows upward), then left-to-right within a line
    items.sort((a, b) => (Math.abs(a.y - b.y) > Y_TOLERANCE ? b.y - a.y : a.x - b.x));

    const lines: string[] = [];
    let current: PdfItem[] = [];
    let lineY: number | null = null;

    const flush = () => {
      if (!current.length) return;
      current.sort((a, b) => a.x - b.x);
      const text = current
        .map((i) => i.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) lines.push(text);
      current = [];
    };

    for (const it of items) {
      if (lineY === null || Math.abs(it.y - lineY) <= Y_TOLERANCE) {
        current.push(it);
        if (lineY === null) lineY = it.y;
      } else {
        flush();
        current.push(it);
        lineY = it.y;
      }
    }
    flush();

    pages.push(lines.join("\n"));
  }

  return pages.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function parseResumeFile(
  buffer: Buffer,
  mime: string,
  filename: string,
): Promise<string> {
  const name = filename.toLowerCase();

  if (mime === "application/pdf" || name.endsWith(".pdf")) {
    // TEXT FIRST: the glyph-position pass is free + instant and handles most
    // résumés well. Only when it comes back THIN (a designed/multi-column or
    // image-only PDF where the text layer is sparse) do we pay for vision/OCR —
    // so a normal upload never hits OpenRouter. RESUME_PARSE=vision arms it.
    const layout = await parsePdfLayout(buffer);
    const thin = layout.replace(/\s+/g, "").length < 300;
    if (VISION_PARSE_ON && thin) {
      try {
        const md = await visionParsePdf(buffer);
        if (md.length > 50) return md;
      } catch (err) {
        console.warn("[parse] vision parse failed — keeping text:", err instanceof Error ? err.message : err);
      }
    }
    if (layout.length > 50) return layout;
    // fallback: naive extraction if position reconstruction produced nothing
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return text.trim();
  }

  if (mime.includes("word") || name.endsWith(".docx")) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value.trim();
  }

  if (mime.startsWith("text/") || name.endsWith(".txt")) {
    return buffer.toString("utf8").trim();
  }

  throw new Error(`Unsupported file type: ${mime || filename}`);
}
