/**
 * Screenshot the real app for the website's OpenBuilds page.
 *
 * Drives the LOCAL dev server as the fixed test user (no credentials, no real
 * personal data), captures each screen clipped to its content — so the shots
 * fill the frame instead of floating in empty margins — and writes them
 * straight into the website repo at 2x for retina.
 *
 * Requires: `npm run dev` already running on :3000.
 *
 *   npx tsx tools/shoot-screens.ts [outDir]
 */
import { mkdirSync } from "node:fs";
import { TEST_USER_ID } from "../src/lib/dev/test-user";

const BASE = process.env.SHOOT_BASE ?? "http://localhost:3000";
const OUT =
  process.argv[2] ??
  "C:/Users/user/Documents/neelesh-website/public/media/drizzle";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

/** Union of the first `count` matches, padded — so a shot can span two cards. */
type Target = {
  name: string;
  path: string;
  /** element(s) to frame; omitted = whole viewport */
  clip?: {
    selector: string;
    count?: number;
    /** child selector whose text must differ between picked elements — the pool
     *  still carries duplicate postings, and two identical cards read as a bug */
    distinctBy?: string;
  };
  /** wait for this before shooting */
  waitFor?: string;
  /** extra settle time for animations/streaming data */
  settleMs?: number;
  /** override the viewport for this shot */
  viewport?: { width: number; height: number };
  /** jpeg for gradient-heavy shots (PNG bloats them); png keeps small text crisp */
  format?: "png" | "jpeg";
};

/** Dev-only chrome that must never reach a public page. */
const STRIP_DEV_UI = () => {
  const kill: Element[] = [];
  for (const el of document.querySelectorAll("div, a, span, button")) {
    const t = el.textContent ?? "";
    if (t.includes("Viewing as TEST USER") && (el as HTMLElement).style.position === "fixed") kill.push(el);
  }
  kill.push(...document.querySelectorAll('a[href="/debug"], a[href^="/admin"]'));
  const DEV_LABELS = new Set(["🔧 Debug", "Debug", "🏠 Local", "🧠 Claude"]);
  for (const el of document.querySelectorAll("a, button, span, div")) {
    const t = (el.textContent ?? "").trim();
    // outermost element whose ENTIRE text is a dev label (so we take the chip,
    // not the bare text node inside it)
    if (DEV_LABELS.has(t) && !kill.some((k) => k.contains(el))) kill.push(el);
  }
  kill.forEach((el) => el.remove());
};

const TARGETS: Target[] = [
  {
    name: "app-matches",
    path: "/dashboard",
    clip: { selector: ".rec-card", count: 2, distinctBy: ".rec-title, h3, h2" },
    waitFor: ".rec-card",
    settleMs: 2500,
  },
  {
    name: "app-resume",
    path: "/resume",
    settleMs: 3500,
  },
  {
    name: "app-mentor",
    path: "/mentor",
    settleMs: 3500,
    viewport: { width: 1180, height: 760 },
    format: "jpeg", // near-pure gradient — PNG was 911KB, jpeg is a fraction
  },
  {
    // the tool-calling moment: mid-call, the mentor surfaces real roles as cards
    name: "app-mentor-cards",
    path: "/mentor?shot=cards",
    waitFor: ".call-role",
    settleMs: 2500,
    // wide enough that the three cards stay on ONE row, tall enough that none
    // of them is clipped at the fold
    viewport: { width: 1420, height: 1040 },
  },
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const puppeteer = (await import("puppeteer")).default;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--force-color-profile=srgb", "--hide-scrollbars"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 1000, deviceScaleFactor: 2 });

  // sign in as the fixed test user (dev-only route — sets the session cookie)
  await page.goto(`${BASE}/api/auth/dev?u=${TEST_USER_ID}`, { waitUntil: "networkidle2" });
  console.log(`signed in as test user → ${page.url()}\n`);

  for (const t of TARGETS) {
    try {
      if (t.viewport) await page.setViewport({ ...t.viewport, deviceScaleFactor: 2 });
      else await page.setViewport({ width: 1180, height: 1000, deviceScaleFactor: 2 });

      await page.goto(`${BASE}${t.path}`, { waitUntil: "networkidle2", timeout: 60_000 });
      if (t.waitFor) await page.waitForSelector(t.waitFor, { timeout: 45_000 });
      if (t.settleMs) await new Promise((r) => setTimeout(r, t.settleMs));
      await page.evaluate(STRIP_DEV_UI);

      let clip: { x: number; y: number; width: number; height: number } | undefined;
      if (t.clip) {
        const box = await page.evaluate(
          (sel, count, distinctBy) => {
            const all = [...document.querySelectorAll(sel)];
            let els = all.slice(0, count ?? 1);
            const n = count ?? 1;
            if (distinctBy && n > 1) {
              // the frame must be CONTIGUOUS (a union across a gap would swallow
              // whatever sits between), so find the first run of n adjacent cards
              // whose labels are all different. Kept as plain loops on purpose:
              // a named arrow here gets wrapped by tsx's __name helper, which
              // does not exist inside the page.
              const labels: string[] = [];
              for (const e of all) {
                const el2 = e.querySelector(distinctBy);
                labels.push(((el2 && el2.textContent) || "").trim().toLowerCase());
              }
              for (let i = 0; i + n <= all.length; i++) {
                const seen: Record<string, boolean> = {};
                let ok = true;
                for (let j = i; j < i + n; j++) {
                  if (!labels[j] || seen[labels[j]]) { ok = false; break; }
                  seen[labels[j]] = true;
                }
                if (ok) { els = all.slice(i, i + n); break; }
              }
            }
            if (!els.length) return null;
            const rects = els.map((e) => e.getBoundingClientRect());
            const top = Math.min(...rects.map((r) => r.top)) + window.scrollY;
            const left = Math.min(...rects.map((r) => r.left)) + window.scrollX;
            const right = Math.max(...rects.map((r) => r.right)) + window.scrollX;
            const bottom = Math.max(...rects.map((r) => r.bottom)) + window.scrollY;
            return { top, left, right, bottom };
          },
          t.clip.selector,
          t.clip.count ?? 1,
          t.clip.distinctBy ?? "",
        );
        if (box) {
          const pad = 18;
          clip = {
            x: Math.max(0, box.left - pad),
            y: Math.max(0, box.top - pad),
            width: box.right - box.left + pad * 2,
            height: box.bottom - box.top + pad * 2,
          };
        }
      }

      const ext = t.format === "jpeg" ? "jpg" : "png";
      const file = `${OUT}/${t.name}.${ext}`;
      await page.screenshot({
        path: file,
        clip,
        captureBeyondViewport: !!clip,
        ...(t.format === "jpeg" ? { type: "jpeg" as const, quality: 90 } : {}),
      });
      console.log(`  ✓ ${t.name.padEnd(16)} ${t.path}${clip ? `  (${Math.round(clip.width)}×${Math.round(clip.height)} css px)` : ""}`);
    } catch (e) {
      console.log(`  ✗ ${t.name.padEnd(16)} ${(e as Error).message.split("\n")[0]}`);
    }
  }

  await browser.close();
  console.log(`\nwrote to ${OUT}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
