/**
 * Job ingest, split into two phases so the GPU-heavy part is controllable:
 *
 *   fetchRawJobs()  — cheap: pull ATS boards, title-filter, store raw postings
 *                     with vectorizedAt=null (no inference). Safe to run often.
 *   runInference()  — heavy: vectorize the pending rows on the local model, in
 *                     batches with a cooldown between them (thermal headroom).
 *
 * Both the CLI worker and the admin dashboard call these. Pure functions of
 * env + DB — no process.exit, no env mutation; log via callback.
 */
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { opportunities } from "@/db/schema";
import { releaseLiveModel } from "@/llm/ollama";
import { embed, roleEmbedText } from "@/lib/embeddings";
import { COMPANIES } from "./companies";
import { fetchBoard } from "./ats";
import { FAST_MODEL, STRONG_MODEL, TRUSTED_MODELS, extractRole, escalationReason, applyRowAuthority, writeVectorization, cleanSkills, unloadModel } from "./vectorize";
import { VECTORIZE_PROMPT_VERSION } from "@/agents/opportunity-vectorizer";

// Early users are DIVERSE — lawyers, designers, doctors, engineers, PMs,
// writers, remote side-hustlers — so the net is wide across verticals.
// (The old filter was engineer-biased and its exclude list literally blocked
// counsel/legal/marketing titles.) Override with JOBS_TITLE_FILTER.
const DEFAULT_TITLE_FILTER = [
  "engineer|developer|software|architect|devops|infra|platform|\\bai\\b|\\bml\\b|machine learning",
  "design|\\bux\\b|\\bui\\b|creative|brand|visual",
  "product|program|project|manager|operations|strategy|chief of staff",
  "counsel|attorney|legal|paralegal|contracts|compliance",
  "physician|doctor|clinical|nurse|medical|health|care|therapist",
  "research|scientist|data|analyst|analytics",
  "writer|content|marketing|growth|editor|communications",
  "sales|account|success|support|partnership|community",
  "finance|accountant|people|talent|recruit",
].join("|");
// exclusions now empty by default — every vertical is someone's career.
// Set JOBS_TITLE_EXCLUDE to re-introduce noise filtering per deployment.
const DEFAULT_TITLE_EXCLUDE = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// what a board tells us WITHOUT inference — enough to show a placeholder card
function guessRemote(location: string | null, title: string): string {
  const s = `${location ?? ""} ${title}`.toLowerCase();
  if (/\bremote\b/.test(s)) return "remote";
  if (/\bhybrid\b/.test(s)) return "hybrid";
  return "unknown";
}

export type FetchResult = { inserted: number; scanned: number; matched: number; log: string[] };

/** Phase 1 — pull boards and store raw postings (no inference). */
export async function fetchRawJobs(opts?: { log?: (line: string) => void }): Promise<FetchResult> {
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    opts?.log?.(s);
  };
  const titleFilter = new RegExp(process.env.JOBS_TITLE_FILTER ?? DEFAULT_TITLE_FILTER, "i");
  const excludeSrc = process.env.JOBS_TITLE_EXCLUDE ?? DEFAULT_TITLE_EXCLUDE;
  const titleExclude = excludeSrc ? new RegExp(excludeSrc, "i") : null;
  // bound intake per board so remote.com's 283 postings can't drown the mix;
  // the pending pile stays scannable and inference stays a deliberate choice
  const perBoard = Number(process.env.JOBS_FETCH_PER_BOARD ?? 30);

  let inserted = 0;
  let scanned = 0;
  let matched = 0;

  for (const c of COMPANIES) {
    if (!c.slug || c.slug.includes("your")) continue;
    let jobs;
    try {
      // aggregators (consider) pay one fetch per JD, so they take the filter
      // and cap up front; single-call boards ignore the opts
      jobs = await fetchBoard(c.source, c.slug, { titleFilter, cap: perBoard });
    } catch (e) {
      log(`skip ${c.source}:${c.slug} — ${(e as Error).message}`);
      continue;
    }
    const before = jobs.length;
    // filter by title/JD first, but DON'T cap yet. Capping BEFORE dedup meant we
    // re-inspected the same first `perBoard` postings every run and never reached
    // postings N+1…M — so a board's pool froze at its first 30. Dedup, THEN cap.
    const eligible = jobs.filter(
      (j) => j.jd.length >= 80 && titleFilter.test(j.title) && !(titleExclude && titleExclude.test(j.title)),
    );
    scanned += before;
    if (!eligible.length) {
      log(`${c.source}:${c.slug} → 0 eligible of ${before}`);
      continue;
    }

    // skip ones we already have (by external_id), THEN take up to perBoard NEW
    // ones — each run pulls fresh postings until the board is exhausted.
    const ids = eligible.map((j) => j.externalId);
    const existing = await db
      .select({ externalId: opportunities.externalId })
      .from(opportunities)
      .where(inArray(opportunities.externalId, ids));
    const have = new Set(existing.map((e) => e.externalId));

    const fresh = eligible.filter((j) => !have.has(j.externalId)).slice(0, perBoard);
    matched += fresh.length;
    log(`${c.source}:${c.slug} → ${fresh.length} new (of ${eligible.length} eligible / ${before} fetched)`);
    if (!fresh.length) continue;
    // one bulk insert; onConflictDoNothing covers a race with another fetch
    const res = await db
      .insert(opportunities)
      .values(
        fresh.map((j) => ({
          source: c.source,
          externalId: j.externalId,
          url: j.url,
          // aggregator jobs carry their real company; single-company boards
          // fall back to the board slug
          company: j.company || c.slug,
          title: j.title,
          location: j.location,
          remote: guessRemote(j.location, j.title),
          rawText: j.jd,
          vector: {},
          facts: {},
          vectorizedAt: null,
        })),
      )
      .onConflictDoNothing({ target: opportunities.externalId })
      .returning({ id: opportunities.id });
    inserted += res.length;
    log(`  + stored ${res.length} new posting(s)`);
  }

  log(`Fetch done. ${inserted} new posting(s) awaiting inference.`);
  return { inserted, scanned, matched, log: lines };
}

export type InferenceResult = { vectorized: number; failed: number; remaining: number; log: string[] };

// Live progress for the admin UI (single-instance dev server — in-memory is
// exactly right). Also acts as a mutex: one inference run at a time, because
// two concurrent runs on a 15GB-RAM box is how systems crash.
export type InferenceProgress = {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  current: string | null;
  startedAt: number | null;
};
const progress: InferenceProgress = { running: false, total: 0, done: 0, failed: 0, current: null, startedAt: null };
export function inferenceProgress(): InferenceProgress {
  return { ...progress };
}
/** Unjam the mutex if a run dies mid-flight (route catch calls this). */
export function resetInferenceProgress(): void {
  progress.running = false;
  progress.current = null;
}

// Cooperative stop: the admin "Stop" button sets this; the run loops check it
// between rows and exit cleanly (already-extracted rows still get embedded).
let stopRequested = false;
export function stopInference(): void {
  stopRequested = true;
}

/**
 * Evidence-based "is a run active?" — the in-memory mutex above dies whenever
 * Next dev re-instantiates this module (HMR), so mid-run the UI would say idle
 * and let the operator start a SECOND GPU run. A live run stamps a row at least
 * every batch (~2-3 min worst case), so a recent vectorized_at is proof enough.
 * Window = max inter-batch sleep (120s) + one slow generation, with margin.
 * Returns seconds since the last stamp when recent, else null. Cost: a brief
 * post-run lockout before the next click — far cheaper than a GPU race.
 */
export async function recentInferenceActivity(withinSec = 240): Promise<number | null> {
  const [r] = await db
    .select({ ago: sql<number | null>`extract(epoch from now() - max(${opportunities.vectorizedAt}))::int` })
    .from(opportunities);
  return r?.ago != null && r.ago < withinSec ? r.ago : null;
}

/**
 * Phase 2 — vectorize pending rows on the local model. Processes `limit` rows in
 * batches of `batchSize`, sleeping `sleepMs` between batches so the GPU gets
 * thermal headroom on a long run.
 */
export async function runInference(opts?: {
  limit?: number;
  batchSize?: number;
  sleepMs?: number;
  force?: boolean; // reprocess regardless of vectorizedAt (oldest/never first)
  tiered?: boolean; // fast → escalate-to-strong cascade (default on = CLI parity)
  log?: (line: string) => void;
}): Promise<InferenceResult> {
  const limit = opts?.limit ?? Number(process.env.JOBS_INFER_LIMIT ?? 20);
  const batchSize = Math.max(1, opts?.batchSize ?? Number(process.env.JOBS_INFER_BATCH ?? 5));
  const sleepMs = opts?.sleepMs ?? Number(process.env.JOBS_INFER_SLEEP_MS ?? 30000);
  const force = opts?.force ?? false;
  const tiered = opts?.tiered ?? true;
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    opts?.log?.(s);
  };

  // force = BACKFILL, not blind redo: rows that are pending, vectorized before
  // the schema fixes (no needs_review key in facts), stamped by a model no
  // longer in the trusted roster (granite's flat vectors — see lib/jobs/vectorize),
  // OR written under an older PROMPT version (facts.prompt_v stamp — a rubric
  // change re-queues exactly the stale rows). Rows already re-done on the current
  // model+prompt are SKIPPED, so repeated clicks converge to "Backfill complete"
  // instead of churning the pool forever.
  // normal: only pending rows, round-robin across companies so no single board
  // dominates a run.
  const oldSchema = or(
    isNull(opportunities.vectorizedAt),
    sql`not jsonb_exists(${opportunities.facts}, 'needs_review')`,
    sql`coalesce(${opportunities.vectorizeModel}, '') not in (${sql.join(TRUSTED_MODELS.map((m) => sql`${m}`), sql`, `)})`,
    sql`coalesce((${opportunities.facts} ->> 'prompt_v')::int, 1) <> ${VECTORIZE_PROMPT_VERSION}`,
  );
  const rows = force
    ? await db
        .select()
        .from(opportunities)
        .where(and(ne(opportunities.source, "sample"), oldSchema))
        .orderBy(sql`${opportunities.vectorizedAt} asc nulls first`, asc(opportunities.createdAt))
        .limit(limit)
    : await db
        .select()
        .from(opportunities)
        .where(isNull(opportunities.vectorizedAt))
        .orderBy(
          sql`row_number() over (partition by ${opportunities.company} order by ${opportunities.createdAt} asc)`,
          asc(opportunities.createdAt),
        )
        .limit(limit);

  if (!rows.length) {
    log(force ? "Backfill complete — every row is already on the new schema. 🎉" : "Nothing pending — all fetched jobs are already vectorized.");
    return { vectorized: 0, failed: 0, remaining: 0, log: lines };
  }
  if (progress.running) {
    log("An inference run is already in progress — not starting another.");
    return { vectorized: 0, failed: 0, remaining: rows.length, log: lines };
  }
  progress.running = true;
  progress.total = rows.length;
  progress.done = 0;
  progress.failed = 0;
  progress.current = null;
  progress.startedAt = Date.now();
  stopRequested = false; // fresh run clears any stale stop request
  await releaseLiveModel(); // free the voice model's VRAM first

  const fastModel = tiered ? FAST_MODEL : undefined; // undefined → provider default (legacy single-model)
  const escalate: { id: string; row: (typeof rows)[number] }[] = [];
  let vectorized = 0;
  let failed = 0;
  const modelDesc = !tiered ? "" : FAST_MODEL === STRONG_MODEL ? ` — ${FAST_MODEL} end to end` : ` — ${FAST_MODEL} → escalate to ${STRONG_MODEL}`;
  log(`${force ? "Re-vectorizing" : "Vectorizing"} ${rows.length} job(s)${modelDesc}, ${batchSize}/batch, ${Math.round(sleepMs / 1000)}s cooldown.`);

  // Defer embeddings: keep the extractor RESIDENT through both passes (embedding
  // inline loads nomic per row, which evicts the 22GB extractor → reload → the
  // VRAM sawtooth). Collect ids, then embed everything in ONE nomic pass after a
  // single model swap. Also writes embedding_vec (the pgvector column the ranking
  // RPC actually uses) — inline writes only the legacy jsonb, so fresh crunches
  // were silently losing semantic trajectory.
  const embedIds: string[] = [];
  const priorInline = process.env.EMBED_INLINE;
  process.env.EMBED_INLINE = "0";

  // ── Pass 1: fast model (or the single default when !tiered) ──
  for (let i = 0; i < rows.length; i += batchSize) {
    if (stopRequested) { log("⏹ Stopped by user — embedding what completed."); break; }
    const batch = rows.slice(i, i + batchSize);
    log(`Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(rows.length / batchSize)}:`);
    for (const row of batch) {
      if (stopRequested) break;
      progress.current = row.title;
      try {
        const out = await extractRole(row.rawText ?? "", fastModel);
        applyRowAuthority(out, row);
        const reason = tiered ? escalationReason(out.facts) : null; // scrubs skills in place
        if (reason) {
          await db.update(opportunities).set({ needsStrongPass: true }).where(eq(opportunities.id, row.id));
          escalate.push({ id: row.id, row });
          log(`  ↑ ${row.title} — ${reason}, escalating`);
        } else {
          await writeVectorization(row.id, out, fastModel ?? null, row);
          embedIds.push(row.id);
          vectorized++;
          progress.done = vectorized;
          log(`  + ${row.title}`);
        }
      } catch (e) {
        failed++;
        progress.failed = failed;
        log(`  ! ${row.title} — ${(e as Error).message}`);
      }
    }
    if (i + batchSize < rows.length && sleepMs > 0) {
      log(`  …cooling ${Math.round(sleepMs / 1000)}s`);
      await sleep(sleepMs);
    }
  }

  // ── Pass 2: strong model over everything Pass 1 punted (ONE model swap) ──
  if (tiered && escalate.length) {
    if (FAST_MODEL !== STRONG_MODEL) await unloadModel(FAST_MODEL); // same model → keep it warm
    log(`Escalated ${escalate.length} to ${STRONG_MODEL}:`);
    for (let i = 0; i < escalate.length; i += batchSize) {
      if (stopRequested) break;
      for (const { id, row } of escalate.slice(i, i + batchSize)) {
        if (stopRequested) break;
        progress.current = row.title;
        try {
          const out = await extractRole(row.rawText ?? "", STRONG_MODEL);
          applyRowAuthority(out, row);
          cleanSkills(out.facts); // scrub the strong model's skills too
          await writeVectorization(id, out, STRONG_MODEL, row);
          embedIds.push(id);
          vectorized++;
          progress.done = vectorized;
          log(`  + ${row.title} (strong)`);
        } catch (e) {
          failed++;
          progress.failed = failed;
          log(`  ! ${row.title} (strong) — ${(e as Error).message}`);
        }
      }
      if (i + batchSize < escalate.length && sleepMs > 0) {
        log(`  …cooling ${Math.round(sleepMs / 1000)}s`);
        await sleep(sleepMs);
      }
    }
  }

  // ── deferred embed pass: ONE extractor→nomic swap, then nomic embeds all rows
  // in this run. Writes BOTH embedding (legacy jsonb) and embedding_vec (pgvector,
  // used by the ranking RPC) so semantic trajectory is live for fresh rows. ──
  if (embedIds.length) {
    try {
      await unloadModel(STRONG_MODEL); // free the extractor's VRAM before nomic
      log(`Embedding ${embedIds.length} role(s) — nomic, one pass (no per-row swap)…`);
      const toEmbed = await db
        .select({ id: opportunities.id, title: opportunities.title, facts: opportunities.facts })
        .from(opportunities)
        .where(inArray(opportunities.id, embedIds));
      let embedded = 0;
      for (let i = 0; i < toEmbed.length; i += 32) {
        const b = toEmbed.slice(i, i + 32);
        const vecs = await embed(b.map((r) => roleEmbedText((r.facts ?? {}) as Parameters<typeof roleEmbedText>[0], r.title)));
        await Promise.all(
          b.map((r, j) =>
            vecs[j]?.length
              ? db.execute(sql`UPDATE opportunities SET embedding = ${JSON.stringify(vecs[j])}::jsonb, embedding_vec = ${`[${vecs[j].join(",")}]`}::vector WHERE id = ${r.id}`)
              : Promise.resolve(),
          ),
        );
        embedded += b.length;
      }
      log(`Embedded ${embedded}.`);
    } catch (e) {
      log(`Embed pass failed: ${(e as Error).message} — rankings use lexical trajectory until re-embedded.`);
    }
  }
  process.env.EMBED_INLINE = priorInline;

  progress.running = false;
  progress.current = null;
  const [{ n: remaining }] = force
    ? await db
        .select({ n: sql<number>`count(*)::int` })
        .from(opportunities)
        .where(and(ne(opportunities.source, "sample"), oldSchema))
    : await db.select({ n: sql<number>`count(*)::int` }).from(opportunities).where(isNull(opportunities.vectorizedAt));
  log(`Done. Vectorized ${vectorized}, failed ${failed}, ${remaining} ${force ? "still on the old schema" : "still pending"}.`);
  return { vectorized, failed, remaining, log: lines };
}
