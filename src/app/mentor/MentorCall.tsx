"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/client/api-fetch";
// type-only: the runtime import happens inside startSession — the module's
// RnnoiseWorkletNode extends AudioWorkletNode at class-definition time, which
// crashes SSR (no AudioWorkletNode in Node). Browser-only, loaded on demand.
import type { RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import UserChip from "../UserChip";
import Brand from "../Brand";
import VoiceOrb from "./VoiceOrb";
import { displayCompany } from "@/lib/format/company";

/** The post-call machinery, made visible: while the recap builds, show what
 *  drizzle is actually doing with the conversation — steps advance on a
 *  cadence tuned to the real pipeline (recap ≈ 20-40s on the local model;
 *  ranking + tips genuinely queue behind the review-save). */
function ProcessingSteps() {
  const STEPS = [
    "Reading back the conversation…",
    "Pulling out what we learned about you…",
    "Re-aligning your job queue to who you're becoming…",
    "Scanning the call for résumé-worthy facts…",
    "Writing your recap…",
  ];
  const [done, setDone] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setDone((d) => Math.min(d + 1, STEPS.length - 1)), 6500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="proc-steps">
      {STEPS.map((s, i) => (
        <div key={s} className={`proc-step${i < done ? " done" : i === done ? " live" : ""}`}>
          <span className="proc-mark">{i < done ? "✓" : i === done ? <span className="think-dots"><i /><i /><i /></span> : "·"}</span>
          <span>{s}</span>
        </div>
      ))}
    </div>
  );
}

/** Mentor captions with the load-bearing words in bold: *emphasis*, plus any
 *  role title / company from the call's spectrum. HTML-escaped first. */
function renderCaption(text: string, keyTerms: string[]): string {
  let html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  html = html.replace(/\*([^*\n]{2,60})\*/g, "<b>$1</b>");
  for (const term of [...new Set(keyTerms)]) {
    const re = new RegExp(`(?<!<b>)(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    html = html.replace(re, "<b>$1</b>");
  }
  return html;
}

type Phase = "idle" | "recording" | "thinking" | "speaking";
type Turn = { role: "user" | "assistant"; text: string };
type Insight = { dimension: string; content: string; confidence: number };
type Review = { loading: boolean; summary: string; insights: Insight[]; error?: string };
type Suggestion = {
  kind: "bullet" | "skill";
  text: string;
  rationale: string;
  entryKind: "experience" | "project" | null;
  entryId: string | null;
  entryLabel: string | null;
  status?: "added" | "dismissed";
};

const DIMENSIONS = [
  "aspiration",
  "energizer",
  "drainer",
  "value",
  "constraint",
  "goal",
  "pattern",
  "blocker",
];

// --- voice-activity tuning (all in one place; adjust to taste) ---
const SPEECH_RMS = 0.018; // floor for "counts as speech" (raised by calibration)
const BARGE_RMS = 0.05; // floor to interrupt the mentor mid-sentence
const SILENCE_HANG_MS = 2000; // quiet needed to end your turn — 1.4s clipped people mid-thought at natural pauses
const MIN_SPEECH_MS = 350; // ignore blips shorter than this
const POLL_MS = 60;
const CALIBRATION_MS = 700; // sample the room's noise floor at call start
const BARGE_FRAMES = 4; // ~240ms of sustained speech-shaped sound to interrupt
const SPEECH_BAND = [300, 3400]; // Hz — energy here is speech, not fan hum
const SPEECH_BAND_MIN = 0.32; // fraction of energy that must sit in the speech band
const CALL_LIMIT_SEC = 20 * 60; // countdown length; a focused call, extendable
const EXTEND_SEC = 5 * 60;

export default function MentorCall({ userId }: { userId: string }) {
  // media + analysis
  const streamRef = useRef<MediaStream | null>(null);
  const cleanStreamRef = useRef<MediaStream | null>(null); // RNNoise-denoised stream we actually record
  const rnnoiseRef = useRef<RnnoiseWorkletNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Float32Array<ArrayBuffer>>(new Float32Array(0));
  const freqRef = useRef<Uint8Array<ArrayBuffer>>(new Uint8Array(0));
  // a second analyser tapped off the mentor's TTS so the orb reacts to ITS voice
  // while it speaks (the mic analyser reacts to the user's voice otherwise)
  const voiceAnalyserRef = useRef<AnalyserNode | null>(null);
  const voiceDataRef = useRef<Float32Array<ArrayBuffer>>(new Float32Array(0));
  const voiceSrcRef = useRef<AudioNode | null>(null);
  const lastAudioErrRef = useRef<string>(""); // surfaced in the debug panel
  // streaming turn: sentences arrive one at a time and queue up as <audio>
  // elements (each prebuffering the next while the current one plays)
  const audioQueueRef = useRef<{ text: string; audio: HTMLAudioElement }[]>([]);
  const playingRef = useRef(false); // an audio element is currently playing
  const streamDoneRef = useRef(false); // the turn-stream sent its 'end' frame
  const turnFinishedRef = useRef(false); // finishTurn already ran for this turn
  const streamAbortRef = useRef<AbortController | null>(null);
  // per-turn latency marks (all performance.now()): speechEnd → submit → first
  // sentence frame → first audio playing. Surfaced in the debug panel + console.
  const turnClockRef = useRef<{ speechEnd: number; submit?: number; firstSentence?: number; done?: boolean } | null>(null);
  const [lastTiming, setLastTiming] = useState(""); // debug: last turn's felt-latency split
  const levelRef = useRef(0); // live 0–1 audio amplitude → the VoiceOrb canvas, no re-render
  const vadTimerRef = useRef<number | null>(null);
  // adaptive thresholds — calibrated to the room's noise floor at call start
  const speechThreshRef = useRef(SPEECH_RMS);
  const bargeThreshRef = useRef(BARGE_RMS);
  const bargeCountRef = useRef(0);
  // refs the VAD loop reads without stale closures
  const liveRef = useRef(false);
  const recordingRef = useRef(false);
  const busyRef = useRef(false);
  const speakingRef = useRef(false);
  const speechStartRef = useRef(0);
  // timing channel: WHEN they speak carries meaning the transcript loses —
  // an 8-second silence before "I guess..." is half the message. Captured
  // here (no ML), summarized server-side, fed to the mentor as a tone note.
  const promptEndRef = useRef(0); // when the mentor's voice finished
  const turnMetaRef = useRef<{ answerDelaySec: number | null; speechSec: number | null; barged: boolean }>({ answerDelaySec: null, speechSec: null, barged: false });
  const lastVoiceRef = useRef(0);
  // conversation
  const turnsRef = useRef<Turn[]>([]);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const [live, setLive] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [, setStatus] = useState(""); // value is vestigial (orb+caption convey state); setStatus kept for call sites
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [spokenText, setSpokenText] = useState("");
  const [revealFrac, setRevealFrac] = useState(1);
  const [showTranscript, setShowTranscript] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [limitSec, setLimitSec] = useState(CALL_LIMIT_SEC);
  const limitRef = useRef(CALL_LIMIT_SEC); // mutable via "extend"
  const callStartRef = useRef(0);
  const endSessionRef = useRef<() => void>(() => {});
  const pendingEndRef = useRef(false); // mentor asked to close; end after it speaks
  const [review, setReview] = useState<Review | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMsg, setSaveMsg] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  // 3 roles pre-picked for this call — revealed on screen only when the mentor
  // naturally brings them up (a surprise, not a spoiler).
  type CallRole = { kind: string; title: string; company: string; why: string };
  const spectrumRef = useRef<CallRole[]>([]);
  const [roleCards, setRoleCards] = useState<CallRole[] | null>(null);
  // the human circle, same contract: preloaded silently, revealed the moment
  // the mentor offers an intro by name ("There's someone — Arjun Mehta…")
  type CircleMentor = { id: string; name: string; avatarUrl: string | null; headline: string | null; move: string; why: string };
  const circleRef = useRef<CircleMentor[]>([]);
  const [mentorCards, setMentorCards] = useState<CircleMentor[] | null>(null);
  const [introState, setIntroState] = useState<Record<string, "sending" | "sent">>({});

  // Dev-only screenshot seam. `?shot=cards` holds the stage in the mid-call
  // moment the role cards surface, using the REAL spectrum from the matches
  // API — so tools/shoot-screens.ts can capture tool-calling without a live
  // call (no mic, no turn spent). Never reachable in production.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (new URLSearchParams(window.location.search).get("shot") !== "cards") return;
    let cancelled = false;
    void (async () => {
      const j = await fetch(`/api/opportunities/matches?u=${userId}`)
        .then((r) => r.json())
        .catch(() => null);
      if (cancelled || !j) return;
      type SpectrumRow = { kind: string; job: { title: string | null; company: string | null; why: string } };
      const fromSpectrum: CallRole[] = (j.spectrum ?? []).map((s: SpectrumRow) => ({
        kind: s.kind,
        title: s.job.title ?? "",
        company: s.job.company ?? "",
        why: s.job.why,
      }));
      // the spectrum is only populated once a direction exists — fall back to
      // the top matches so the shot is never an empty stage
      const roles = fromSpectrum.length
        ? fromSpectrum
        : ((j.matches ?? []) as { title: string | null; company: string | null; why: string }[])
            .slice(0, 3)
            .map((m) => ({ kind: "a match", title: m.title ?? "", company: m.company ?? "", why: m.why }));
      if (!roles.length) return;
      setLive(true);
      enter("speaking");
      setSpokenText("Three of these keep coming back to your direction — which one pulls at you?");
      setRoleCards(roles);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function requestIntroInCall(mentorId: string) {
    setIntroState((s) => ({ ...s, [mentorId]: "sending" }));
    try {
      const r = await fetch("/api/mentors/intro", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ u: userId, mentorId }),
      });
      if (!r.ok) throw new Error();
      setIntroState((s) => ({ ...s, [mentorId]: "sent" }));
    } catch {
      setIntroState((s) => {
        const { [mentorId]: _drop, ...rest } = s;
        return rest;
      });
    }
  }
  // debug A/B: which brain answers — local Ollama or Anthropic. Dev-only UI;
  // the server independently gates the override, so this is safe to render.
  const [brain, setBrain] = useState<"ollama" | "anthropic">("ollama");
  const brainRef = useRef(brain);
  brainRef.current = brain;
  // debug panel: live health of every voice-stack component (dev-only UI)
  type Health = {
    config: { liveModel: string; mentorProvider: string };
    voicebox: { up?: boolean; modelLoaded?: boolean; gpu?: string; vramMb?: number; error?: string };
    ollama: { up?: boolean; liveModelPulled?: boolean; models?: number; error?: string };
    generation: { ok?: boolean; latencyMs?: number; reply?: string; error?: string };
    checkedAt: string;
  };
  const [debugOpen, setDebugOpen] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  async function checkHealth() {
    setHealthBusy(true);
    try {
      const r = await fetch("/api/voice/health", { cache: "no-store" });
      setHealth(await r.json());
    } catch {
      setHealth(null);
    } finally {
      setHealthBusy(false);
    }
  }
  function testSpeaker() {
    lastAudioErrRef.current = "";
    playText("Testing, one two three. If you can hear this, the speaker path works end to end.");
  }

  function enter(p: Phase) {
    setPhase(p);
    recordingRef.current = p === "recording";
    busyRef.current = p === "thinking";
    speakingRef.current = p === "speaking";
  }

  // warm the models on page load; run the call timer while live
  useEffect(() => {
    fetch("/api/voice/warmup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }), // dev ?u= fallback; session wins in prod
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      if (!callStartRef.current) return; // still connecting — the clock hasn't started
      const e = Math.floor((Date.now() - callStartRef.current) / 1000);
      setElapsed(e);
      // hard backstop at 0:00 — but if the mentor is mid-reply (speaking or a
      // turn in flight), grant up to 45s of grace so its polite close can land
      // instead of being cut off mid-sentence
      const grace = speakingRef.current || busyRef.current ? 45 : 0;
      if (e >= limitRef.current + grace) endSessionRef.current();
    }, 1000);
    return () => clearInterval(id);
  }, [live]);
  // Speech-reactive orb: one rAF while live reads real amplitude (mentor's voice
  // while it speaks, else the mic) and writes --orb-level so a white dot grows /
  // shrinks with the sound. CSS-var only — no React renders, so it's near-free.
  useEffect(() => {
    if (!live) return;
    let raf = 0;
    let smooth = 0;
    const loop = () => {
      let level = 0;
      const va = voiceAnalyserRef.current;
      if (speakingRef.current && va) {
        const b = voiceDataRef.current;
        va.getFloatTimeDomainData(b);
        let s = 0;
        for (let i = 0; i < b.length; i++) s += b[i] * b[i];
        level = Math.sqrt(s / b.length);
      } else if (analyserRef.current) {
        level = computeRms(); // the user's mic
      }
      // speech RMS sits ~0.01–0.25 → map into 0..1 with a small noise floor
      const target = Math.max(0, Math.min(1, (level - 0.012) * 7));
      // fast attack, gentle release — lively but not jittery (Siri-like)
      smooth += (target - smooth) * (target > smooth ? 0.5 : 0.14);
      levelRef.current = smooth; // → VoiceOrb canvas envelope
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      levelRef.current = 0;
    };
  }, [live]);

  const remaining = Math.max(0, limitSec - elapsed);
  function extendCall() {
    limitRef.current += EXTEND_SEC;
    setLimitSec(limitRef.current);
  }
  endSessionRef.current = endSession; // live handle for timer / audio-end callbacks
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, showTranscript]);

  function pushTurn(t: Turn) {
    turnsRef.current = [...turnsRef.current, t];
    setTurns(turnsRef.current);
  }
  // Reveal the role cards the moment the mentor actually brings one up. The
  // mentor paraphrases ("the founding engineer role at that fintech"), so exact
  // title matching missed real mentions — match enough title words, or a
  // company name WITH role context. A company alone is NOT a role mention:
  // "how's it been since the offer from Anthropic?" must not summon the
  // Anthropic job card (that greeting was revealing the spectrum every call).
  function maybeRevealRoles(replyText: string) {
    if (roleCards || !spectrumRef.current.length) return;
    const t = ` ${replyText.toLowerCase().replace(/[^a-z0-9 ]+/g, " ")} `;
    const roleContext = /\b(role|roles|position|positions|opening|openings|job|jobs|hiring|listing|posting)\b/.test(t);
    const named = spectrumRef.current.some((r) => {
      if (roleContext && r.company && t.includes(` ${r.company.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim()} `)) return true;
      const words = (r.title ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3);
      if (!words.length) return false;
      const hits = words.filter((w) => t.includes(` ${w}`)).length;
      return hits / words.length >= 0.6; // most of the title's real words spoken
    });
    if (named) setRoleCards(spectrumRef.current);
  }
  // Reveal the CIRCLE the moment the mentor offers a person by name. Names are
  // spoken verbatim (the prompt forbids inventing people), so matching is
  // stricter than roles: full name, or a distinctive (≥4 chars) surname.
  function maybeRevealMentors(replyText: string) {
    if (mentorCards || !circleRef.current.length) return;
    const t = ` ${replyText.toLowerCase().replace(/[^a-z0-9 ]+/g, " ")} `;
    const named = circleRef.current.filter((m) => {
      const full = m.name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
      if (full && t.includes(` ${full} `)) return true;
      const last = full.split(/\s+/).pop() ?? "";
      return last.length >= 4 && t.includes(` ${last} `);
    });
    if (named.length) {
      // the person the mentor just offered leads; the rest of the circle follows
      const rest = circleRef.current.filter((m) => !named.some((n) => n.id === m.id));
      setMentorCards([...named, ...rest]);
    }
  }
  function buildTranscript(list: Turn[]) {
    return list.map((t) => `${t.role === "user" ? "You" : "Mentor"}: ${t.text}`).join("\n");
  }

  // Wire one <audio> element to the orb + caption + reveal animation and play
  // it. /api/voice/stream pipes Kokoro's chunked audio, so playback starts in
  // ~1s instead of waiting for the whole clip. A streaming source often reports
  // duration=Infinity, so the caption reveal falls back to a words-per-second
  // estimate. onDone fires exactly once when the clip finishes (or gives up) —
  // the caller decides whether that ends the turn or advances a sentence queue.
  function wireAndPlay(text: string, audio: HTMLAudioElement, onDone: () => void) {
    audioRef.current = audio;
    // Tap the mentor's voice for the reactive orb via captureStream(): a COPY of
    // the audio, so playback stays on the element's own output path. (The old
    // createMediaElementSource approach REROUTED playback through the AudioContext
    // — any graph hiccup meant total silence with no error. Never again.)
    audio.addEventListener(
      "playing",
      () => {
        // one-shot per-turn latency mark: first audio actually playing. Split the
        // felt gap into hang (silence-detect + upload) / stt+llm (server turn) / tts.
        const clk = turnClockRef.current;
        if (clk && !clk.done && clk.submit) {
          clk.done = true;
          const t = performance.now();
          const felt = Math.round(t - clk.speechEnd);
          const hang = Math.round(clk.submit - clk.speechEnd);
          const net = clk.firstSentence ? Math.round(clk.firstSentence - clk.submit) : -1;
          const tts = clk.firstSentence ? Math.round(t - clk.firstSentence) : -1;
          const line = `felt ${felt}ms = hang ${hang} + stt+llm ${net} + tts ${tts}`;
          setLastTiming(line);
          console.log(`[mentor-timing] ${line}`);
        }
        const ctx = ctxRef.current;
        const cap = (audio as HTMLAudioElement & { captureStream?: () => MediaStream }).captureStream?.();
        if (!ctx || !cap || cap.getAudioTracks().length === 0) return;
        try {
          voiceSrcRef.current?.disconnect();
          const src = ctx.createMediaStreamSource(cap);
          if (!voiceAnalyserRef.current) {
            const va = ctx.createAnalyser();
            va.fftSize = 512;
            va.smoothingTimeConstant = 0.6;
            voiceAnalyserRef.current = va;
            voiceDataRef.current = new Float32Array(va.fftSize);
            // analysis only — NEVER connected to ctx.destination
          }
          src.connect(voiceAnalyserRef.current);
          voiceSrcRef.current = src;
        } catch {
          /* no orb reactivity this turn — audio is unaffected */
        }
      },
      { once: true },
    );
    setSpokenText(text);
    setRevealFrac(0);
    enter("speaking");
    const words = text.split(/\s+/).filter(Boolean).length;
    const estDur = Math.max(1.5, words / 2.7); // ~2.7 words/sec TTS pace
    audio.ontimeupdate = () => {
      const d = audio.duration && isFinite(audio.duration) ? audio.duration : estDur;
      setRevealFrac(Math.min(1, audio.currentTime / d));
    };
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      setRevealFrac(1);
      onDone();
    };
    audio.onended = done;
    // "no supported source" = the stream endpoint fumbled its first chunk
    // (Kokoro hiccup) — ONE fresh attempt beats a silent turn. Never retry
    // once real playback started; that would restart the sentence.
    const failedLoad = (msg: string) => {
      lastAudioErrRef.current = `${msg} at ${new Date().toLocaleTimeString()}`;
      const neverPlayed = !audio.currentTime || audio.currentTime < 0.3;
      if (neverPlayed && !audio.dataset.retried && liveRef.current) {
        audio.dataset.retried = "1";
        window.setTimeout(() => {
          if (audioRef.current !== audio) return; // a newer turn/sentence took over
          const again = new Audio(`/api/voice/stream?text=${encodeURIComponent(text)}&retry=1`);
          again.dataset.retried = "1";
          audioRef.current = again;
          again.ontimeupdate = audio.ontimeupdate;
          again.onended = done;
          again.onerror = () => {
            lastAudioErrRef.current = `audio retry failed (code ${again.error?.code ?? "?"}) at ${new Date().toLocaleTimeString()}`;
            done();
          };
          void again.play().catch(() => done());
        }, 450);
        return;
      }
      done();
    };
    audio.onerror = () => failedLoad(`audio element error (code ${audio.error?.code ?? "?"}: ${audio.error?.message || "unknown"})`);
    void audio.play().catch((e) => failedLoad(`play() rejected: ${e instanceof Error ? e.message : String(e)}`));
  }

  // Legacy one-shot playback (used only by the /api/voice/turn fallback path,
  // which hands back the WHOLE reply at once). The streaming path uses the
  // sentence queue below instead.
  function playText(text: string) {
    stopPlayback();
    // stage directions sneak past the prompt on small models — "(Pause,
    // letting the silence hang)" would be SPOKEN by TTS and shown in the
    // caption. Strip parentheticals that OPEN with an acting verb; ones
    // carrying real content ("(TxB's first marketplace)") are untouched.
    text = text
      .replace(
        /\s*[(*\[]\s*(?:pauses?|pausing|beat\b|silence|laughs?|laughing|chuckles?|chuckling|sighs?|sighing|smiles?|smiling|nods?|nodding|leans?|leaning|softly|gently|warmly|quietly|thoughtfully|clears throat|takes a (?:deep )?breath|lets? the silence)[^)*\]]*[)*\]]\s*/gi,
        " ",
      )
      .replace(/\s{2,}/g, " ")
      .trim();
    maybeRevealRoles(text); // if the mentor named a role, surface the cards
    maybeRevealMentors(text); // if the mentor offered a PERSON, surface them
    if (!text.trim()) {
      if (liveRef.current) {
        enter("idle");
        setStatus("Listening — just start talking.");
      }
      return;
    }
    const audio = new Audio(`/api/voice/stream?text=${encodeURIComponent(text)}`);
    wireAndPlay(text, audio, endTurn);
  }

  // ---- streaming sentence queue ----
  // The mentor's reply arrives one sentence at a time (see submitTurn). Each is
  // turned into a prebuffering <audio> and played back-to-back, so the mentor
  // starts speaking after sentence 1 instead of the whole paragraph.
  function endTurn() {
    if (turnFinishedRef.current) return;
    turnFinishedRef.current = true;
    promptEndRef.current = performance.now(); // the answer-delay clock starts now
    if (pendingEndRef.current) {
      pendingEndRef.current = false;
      endSessionRef.current(); // the mentor's closing line just finished
      return;
    }
    if (liveRef.current) {
      enter("idle");
      setStatus("Listening — just start talking.");
    }
  }
  function pumpQueue() {
    if (playingRef.current) return;
    const next = audioQueueRef.current.shift();
    if (!next) {
      if (streamDoneRef.current) endTurn(); // queue drained and no more coming
      return;
    }
    playingRef.current = true;
    // reveal the cards as the sentence STARTS — synced to when the name is spoken
    maybeRevealRoles(next.text);
    maybeRevealMentors(next.text);
    wireAndPlay(next.text, next.audio, () => {
      playingRef.current = false;
      pumpQueue();
    });
  }
  function enqueueSentence(text: string) {
    const audio = new Audio(`/api/voice/stream?text=${encodeURIComponent(text)}`);
    audio.preload = "auto"; // start fetching this sentence while the prior one plays
    audioQueueRef.current.push({ text, audio });
    pumpQueue();
  }
  function stopPlayback() {
    try {
      audioRef.current?.pause();
    } catch {}
    for (const q of audioQueueRef.current) {
      try {
        q.audio.pause();
      } catch {}
    }
    audioQueueRef.current = [];
    playingRef.current = false;
  }
  function abortTurnStream() {
    try {
      streamAbortRef.current?.abort();
    } catch {}
    streamAbortRef.current = null;
  }

  // ---- signal helpers ----
  function computeRms(): number {
    const analyser = analyserRef.current;
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(dataRef.current);
    let sum = 0;
    for (let i = 0; i < dataRef.current.length; i++) sum += dataRef.current[i] * dataRef.current[i];
    return Math.sqrt(sum / dataRef.current.length);
  }
  // fraction of spectral energy in the speech band. High for speech; low for
  // fan/AC hum (which lives mostly below 300 Hz).
  function speechBandFraction(): number {
    const analyser = analyserRef.current;
    const ctx = ctxRef.current;
    if (!analyser || !ctx) return 1;
    analyser.getByteFrequencyData(freqRef.current);
    const binHz = ctx.sampleRate / analyser.fftSize;
    const lo = Math.floor(SPEECH_BAND[0] / binHz);
    const hi = Math.min(freqRef.current.length - 1, Math.ceil(SPEECH_BAND[1] / binHz));
    let band = 0;
    let total = 0;
    for (let i = 0; i < freqRef.current.length; i++) {
      total += freqRef.current[i];
      if (i >= lo && i <= hi) band += freqRef.current[i];
    }
    return total > 0 ? band / total : 0;
  }
  // sample the room for ~700ms and set thresholds relative to its noise floor
  function calibrateNoiseFloor() {
    const samples: number[] = [];
    const t0 = performance.now();
    const id = window.setInterval(() => {
      samples.push(computeRms());
      if (performance.now() - t0 >= CALIBRATION_MS) {
        window.clearInterval(id);
        samples.sort((a, b) => a - b);
        const floor = samples[Math.floor(samples.length * 0.75)] ?? 0;
        // Only raise the BARGE threshold off the noise floor — leave the speech
        // threshold at its (low) default so a quiet or pausing voice still
        // registers and the user's turn isn't cut off mid-thought.
        bargeThreshRef.current = Math.max(BARGE_RMS, floor * 5);
      }
    }, 50);
  }

  // ---- the voice-activity loop: decides when you start and stop talking ----
  function vadTick() {
    const analyser = analyserRef.current;
    if (!analyser || !liveRef.current || busyRef.current) return;
    const rms = computeRms();
    const now = performance.now();
    const voiced = rms > speechThreshRef.current;

    if (speakingRef.current) {
      // interrupt the mentor only on sustained, speech-SHAPED, loud sound — a
      // brief fan spike (low-frequency, not sustained) no longer takes the floor
      if (rms > bargeThreshRef.current && speechBandFraction() > SPEECH_BAND_MIN) {
        if (++bargeCountRef.current >= BARGE_FRAMES) {
          bargeCountRef.current = 0;
          // take the floor: stop the current sentence, drop any queued ones, and
          // abort the in-flight stream so no more sentences are generated/spoken
          abortTurnStream();
          stopPlayback();
          turnMetaRef.current = { answerDelaySec: null, speechSec: null, barged: true }; // they took the floor
          beginRecording(now);
        }
      } else {
        bargeCountRef.current = 0;
      }
      return;
    }
    if (recordingRef.current) {
      if (voiced) lastVoiceRef.current = now;
      if (now - lastVoiceRef.current >= SILENCE_HANG_MS) endRecording(now);
    } else if (voiced) {
      // normal turn-taking: how long they sat with the question before speaking
      turnMetaRef.current = {
        answerDelaySec: promptEndRef.current ? Math.round(((now - promptEndRef.current) / 1000) * 10) / 10 : null,
        speechSec: null,
        barged: false,
      };
      beginRecording(now);
    }
  }

  function beginRecording(now: number) {
    const stream = cleanStreamRef.current ?? streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(stream, { mimeType: pickMime() });
    } catch {
      mr = new MediaRecorder(stream);
    }
    mr.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
    mr.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type || "audio/webm" });
      void submitTurn(blob);
    };
    recorderRef.current = mr;
    mr.start();
    speechStartRef.current = now;
    lastVoiceRef.current = now;
    enter("recording");
    setStatus("I hear you…");
  }

  function endRecording(now: number) {
    const mr = recorderRef.current;
    recordingRef.current = false;
    if (!mr) return;
    if (now - speechStartRef.current < MIN_SPEECH_MS) {
      mr.onstop = null; // too short — discard, keep listening
      try {
        mr.stop();
      } catch {}
      enter("idle");
      setStatus("Listening — just start talking.");
      return;
    }
    turnMetaRef.current.speechSec = Math.round(((now - speechStartRef.current) / 1000) * 10) / 10;
    // latency clock starts at the moment they actually stopped talking (last
    // voiced frame), so the silence-hang shows up as its own chunk
    turnClockRef.current = { speechEnd: lastVoiceRef.current };
    try {
      mr.stop(); // → onstop → submitTurn
    } catch {}
  }

  // Build the multipart body for a turn (shared by the streaming path and the
  // legacy fallback). Whisper decodes PCM WAV reliably but 500s on webm/opus, so
  // transcode to 16kHz mono WAV in the browser before sending.
  async function turnFormData(blob: Blob): Promise<FormData> {
    let audioBlob = blob;
    let filename = "turn.wav";
    try {
      audioBlob = await toWav(blob);
    } catch {
      filename = blob.type.includes("ogg") ? "turn.ogg" : "turn.webm";
    }
    const fd = new FormData();
    fd.append("audio", audioBlob, filename);
    fd.append("userId", userId);
    fd.append(
      "history",
      JSON.stringify(turnsRef.current.map((t) => ({ role: t.role, content: t.text }))),
    );
    const secondsLeft = callStartRef.current
      ? Math.max(0, limitRef.current - Math.floor((Date.now() - callStartRef.current) / 1000))
      : limitRef.current; // clock not started yet — report a full tank
    fd.append("secondsLeft", String(secondsLeft));
    fd.append("timing", JSON.stringify(turnMetaRef.current)); // HOW they spoke, not what they said
    fd.append("brain", brainRef.current); // debug A/B — server ignores unless dev/admin
    return fd;
  }

  // Reset per-turn stream state and arm a fresh abort controller.
  function resetTurnStream(): AbortController {
    audioQueueRef.current = [];
    playingRef.current = false;
    streamDoneRef.current = false;
    turnFinishedRef.current = false;
    const ac = new AbortController();
    streamAbortRef.current = ac;
    return ac;
  }

  // Read the NDJSON turn stream: push the user line, speak each sentence as it
  // lands, push the full assistant reply, finalize. Shared by voice turns and
  // card dives. state.progressed flips once any frame arrives (past fallback).
  async function consumeTurnStream(res: Response, state: { progressed: boolean }): Promise<void> {
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let full = "";
    let assistantPushed = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { t: string; text?: string; ended?: boolean; replyText?: string; message?: string; roles?: CallRole[] };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.t === "user") {
          state.progressed = true;
          if (msg.text) pushTurn({ role: "user", text: msg.text });
        } else if (msg.t === "cards" && Array.isArray(msg.roles) && msg.roles.length) {
          // B2: fresh direction recs — surface them + make them dive-able (B1)
          spectrumRef.current = msg.roles;
          setRoleCards(msg.roles);
        } else if (msg.t === "nospeech") {
          enter("idle");
          setStatus("Didn't catch that — go ahead.");
          return;
        } else if (msg.t === "sentence" && msg.text) {
          state.progressed = true;
          if (turnClockRef.current && !turnClockRef.current.firstSentence) turnClockRef.current.firstSentence = performance.now();
          full += (full ? " " : "") + msg.text;
          enqueueSentence(msg.text);
        } else if (msg.t === "end") {
          if (msg.ended) pendingEndRef.current = true; // end the call after this reply plays
          const replyText = msg.replyText || full;
          if (replyText && !assistantPushed) {
            pushTurn({ role: "assistant", text: replyText });
            assistantPushed = true;
          }
          streamDoneRef.current = true;
          if (!playingRef.current && audioQueueRef.current.length === 0) endTurn();
        } else if (msg.t === "error") {
          throw new Error(msg.message || "stream error");
        }
      }
    }
    // stream closed without an explicit 'end' — make sure the turn finalizes
    streamDoneRef.current = true;
    if (!playingRef.current && audioQueueRef.current.length === 0) endTurn();
  }

  // Streaming voice turn: falls back to the one-shot /api/voice/turn if the
  // stream can't even start (so a hiccup never silently drops a turn).
  async function submitTurn(blob: Blob) {
    enter("thinking");
    setStatus("Thinking…");
    if (turnClockRef.current) turnClockRef.current.submit = performance.now();
    const ac = resetTurnStream();
    const state = { progressed: false };
    try {
      const fd = await turnFormData(blob);
      const res = await fetch("/api/voice/turn-stream", { method: "POST", body: fd, signal: ac.signal });
      await consumeTurnStream(res, state);
    } catch (err) {
      if (ac.signal.aborted) return; // barged / superseded — expected, not an error
      if (!state.progressed) {
        console.warn("[mentor] stream turn failed before start — falling back", err);
        await submitTurnLegacy(blob);
        return;
      }
      // mid-stream failure after we'd already started speaking: don't restart
      lastAudioErrRef.current = `stream turn error: ${err instanceof Error ? err.message : String(err)}`;
      streamDoneRef.current = true;
      if (!playingRef.current && audioQueueRef.current.length === 0) endTurn();
    }
  }

  // One-shot fallback: the whole reply comes back at once, then plays. Kept for
  // resilience if the streaming endpoint is unavailable.
  async function submitTurnLegacy(blob: Blob) {
    try {
      const fd = await turnFormData(blob);
      const res = await fetch("/api/voice/turn", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Turn failed");
      if (!json.userText) {
        enter("idle");
        setStatus("Didn't catch that — go ahead.");
        return;
      }
      pushTurn({ role: "user", text: json.userText });
      if (json.ended) pendingEndRef.current = true; // end the call after this reply plays
      if (json.replyText) {
        pushTurn({ role: "assistant", text: json.replyText });
        turnFinishedRef.current = false;
        playText(json.replyText);
      } else {
        enter("idle");
        setStatus("Listening — just start talking.");
      }
    } catch (err) {
      enter("idle");
      setStatus(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  // Card as a DOORWAY: clicking a path card fires a text turn that names the role,
  // so the mentor's role-dossier capability fires and it DIVES into that path —
  // what it really is, which skills transfer, comp arc, who made the jump. No
  // audio, no STT — reuses the same streaming reply pipeline as a spoken turn.
  async function sendCardDive(role: CallRole) {
    if (!liveRef.current) return;
    const co = displayCompany(role.company);
    const prompt = `Walk me through ${role.title}${co ? ` at ${co}` : ""} — what would that path actually look like for me, and who's made that jump?`;
    abortTurnStream(); // if the mentor's mid-sentence, take the floor
    stopPlayback();
    setRoleCards(null); // collapse the trio — we're diving into one
    turnClockRef.current = null; // text turn, no speech-latency clock
    enter("thinking");
    setStatus("Exploring that path…");
    // remember this branch for the explored-paths comparison (fire-and-forget)
    void fetch("/api/mentor/explored", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, label: role.title, company: role.company, kind: role.kind, source: "card_dive", summary: { why: role.why } }),
    }).catch(() => {});
    const ac = resetTurnStream();
    const state = { progressed: false };
    try {
      const fd = new FormData();
      fd.append("text", prompt);
      fd.append("userId", userId);
      fd.append("history", JSON.stringify(turnsRef.current.map((t) => ({ role: t.role, content: t.text }))));
      const secondsLeft = callStartRef.current
        ? Math.max(0, limitRef.current - Math.floor((Date.now() - callStartRef.current) / 1000))
        : limitRef.current;
      fd.append("secondsLeft", String(secondsLeft));
      fd.append("brain", brainRef.current);
      const res = await fetch("/api/voice/turn-stream", { method: "POST", body: fd, signal: ac.signal });
      await consumeTurnStream(res, state);
    } catch (err) {
      if (ac.signal.aborted) return;
      lastAudioErrRef.current = `dive error: ${err instanceof Error ? err.message : String(err)}`;
      enter("idle");
      setStatus("Listening — just start talking.");
    }
  }

  // ---- the call lane: ONE live call per GPU. Join; if the mentor is busy,
  // wait with an honest position and auto-start when the lane frees. ----
  const [queuePos, setQueuePos] = useState<number | null>(null);
  const queuePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const beatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const laneCall = useCallback(
    (action: "join" | "beat" | "leave") =>
      fetch("/api/voice/queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ u: userId, action }),
      }).then((r) => r.json()),
    [userId],
  );

  function stopQueuePolling() {
    if (queuePollRef.current) clearInterval(queuePollRef.current);
    queuePollRef.current = null;
  }

  // navigating away releases the lane (the 30s heartbeat eviction is the backstop)
  useEffect(
    () => () => {
      if (queuePollRef.current) clearInterval(queuePollRef.current);
      if (beatRef.current) clearInterval(beatRef.current);
      void laneCall("leave").catch(() => {});
    },
    [laneCall],
  );

  async function startSession() {
    setError(null);
    try {
      const lane = await laneCall("join");
      if (lane.state === "waiting") {
        setQueuePos(lane.position);
        setStatus(`Your mentor is with someone right now — you're #${lane.position} in line.`);
        stopQueuePolling();
        queuePollRef.current = setInterval(async () => {
          const s = await laneCall("join").catch(() => null);
          if (!s) return;
          if (s.state === "live") {
            stopQueuePolling();
            setQueuePos(null);
            void beginCall(); // the lane is ours — start for real
          } else {
            setQueuePos(s.position);
          }
        }, 5000);
        return;
      }
    } catch {
      /* queue endpoint unreachable — don't block the call over telemetry */
    }
    setQueuePos(null);
    await beginCall();
  }

  async function beginCall() {
    setError(null);
    // hold the lane with a heartbeat for the whole call
    if (beatRef.current) clearInterval(beatRef.current);
    beatRef.current = setInterval(() => void laneCall("beat").catch(() => {}), 10000);
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        // Keep AGC + noiseSuppression on so the voice stays LOUD and steady fan
        // hum is filtered by the browser. (Fan-resistance for barge-in is handled
        // by speech-band gating below, not by starving the mic of gain.)
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      setError("Microphone access is needed for the call. Allow it and try again.");
      return;
    }
    // RNNoise assumes 48kHz. Route mic → RNNoise → (analyser + recorder), so the
    // VAD and Whisper both get denoised audio. Falls back to the raw mic if the
    // worklet/wasm can't load.
    const ctx = new AudioContext({ sampleRate: 48000 });
    ctxRef.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const source = ctx.createMediaStreamSource(streamRef.current);
    try {
      // browser-only module — see the type-only import note at the top
      const { RnnoiseWorkletNode, loadRnnoise } = await import("@sapphi-red/web-noise-suppressor");
      await ctx.audioWorklet.addModule("/rnnoise/workletProcessor.js");
      const wasmBinary = await loadRnnoise({
        url: "/rnnoise/rnnoise.wasm",
        simdUrl: "/rnnoise/rnnoise_simd.wasm",
      });
      const rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
      rnnoiseRef.current = rnnoise;
      const dest = ctx.createMediaStreamDestination();
      source.connect(rnnoise);
      rnnoise.connect(analyser); // VAD reads the cleaned signal
      rnnoise.connect(dest); // recorder captures the cleaned signal
      cleanStreamRef.current = dest.stream;
    } catch (e) {
      console.warn("[mentor] RNNoise unavailable, using raw mic", e);
      source.connect(analyser);
      cleanStreamRef.current = streamRef.current;
    }
    analyserRef.current = analyser;
    dataRef.current = new Float32Array(analyser.fftSize);
    freqRef.current = new Uint8Array(analyser.frequencyBinCount);
    calibrateNoiseFloor(); // measure the room over the next ~700ms

    turnsRef.current = [];
    setTurns([]);
    setReview(null);
    setRoleCards(null);
    callStartRef.current = 0; // the 20-min clock starts when the mentor SPEAKS, not now —
    // model warm-up and greeting generation shouldn't eat the user's call time
    limitRef.current = CALL_LIMIT_SEC;
    setLimitSec(CALL_LIMIT_SEC);
    setElapsed(0);
    pendingEndRef.current = false;
    setShowTranscript(false);
    setSaveState("idle");
    setSaveMsg("");
    liveRef.current = true;
    setLive(true);
    enter("thinking");
    setStatus("Getting your mentor on the line…");
    // a fresh call starts with a clean stage — cards revealed LAST call must
    // not carry over (the component survives between calls on this page)
    setRoleCards(null);
    setMentorCards(null);
    setIntroState({});
    spectrumRef.current = [];
    circleRef.current = [];
    promptEndRef.current = 0;
    vadTimerRef.current = window.setInterval(vadTick, POLL_MS);

    // silently pre-load the 3-role spectrum; it's revealed only if the mentor
    // brings a role up during the call (a surprise, not a spoiler)
    apiFetch(`/api/opportunities/matches?u=${userId}`)
      .then((r) => r.json())
      .then((j) => {
        spectrumRef.current = (j.spectrum ?? []).map(
          (s: { kind: string; job: { title: string | null; company: string | null; why: string } }) => ({
            kind: s.kind,
            title: s.job.title ?? "",
            company: s.job.company ?? "",
            why: s.job.why,
          }),
        );
      })
      .catch(() => {});
    // …and the human circle, same contract: revealed only when a person is offered
    fetch(`/api/mentors?u=${userId}`)
      .then((r) => r.json())
      .then((j) => {
        circleRef.current = ((j.matches ?? []) as { id: string; name: string | null; avatarUrl: string | null; headline: string | null; transitions: { from: string; to: string }[]; why: string[] }[])
          .slice(0, 3)
          .filter((m) => m.name)
          .map((m) => ({
            id: m.id,
            name: m.name as string,
            avatarUrl: m.avatarUrl,
            headline: m.headline,
            move: m.transitions[0] ? `${m.transitions[0].from} → ${m.transitions[0].to}` : "",
            why: m.why[0] ?? "",
          }));
      })
      .catch(() => {});

    // Warm the voice stack WHILE the greeting is generated — both finish before
    // the clock starts, so cold-start (often ~10s) costs the user nothing.
    try {
      const [, res] = await Promise.all([
        fetch("/api/voice/warmup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) }).catch(() => null),
        fetch("/api/voice/greeting", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId }),
        }),
      ]);
      const json = await res.json();
      if (res.ok && json.text) {
        callStartRef.current = Date.now(); // NOW the 20 minutes begin
        pushTurn({ role: "assistant", text: json.text });
        playText(json.text);
      } else throw new Error(json.error || "greeting failed");
    } catch {
      callStartRef.current = Date.now();
      pushTurn({
        role: "assistant",
        text: "Hey — I'm your career mentor. Where are you in your search right now, and how's it feeling?",
      });
      enter("idle");
      setStatus("Listening — just start talking.");
    }
  }

  function endSession() {
    liveRef.current = false;
    // free the lane for whoever's waiting
    if (beatRef.current) clearInterval(beatRef.current);
    beatRef.current = null;
    stopQueuePolling();
    void laneCall("leave").catch(() => {});
    if (vadTimerRef.current) clearInterval(vadTimerRef.current);
    const mr = recorderRef.current;
    if (mr) {
      mr.onstop = null;
      try {
        mr.stop();
      } catch {}
    }
    try {
      rnnoiseRef.current?.destroy();
    } catch {}
    rnnoiseRef.current = null;
    cleanStreamRef.current = null;
    try {
      voiceSrcRef.current?.disconnect();
    } catch {}
    voiceSrcRef.current = null;
    voiceAnalyserRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current?.close().catch(() => {});
    abortTurnStream();
    stopPlayback();
    enter("idle");
    setLive(false);
    setStatus("Session ended. Pulling together a recap…");
    void generateSummary();
  }

  async function generateSummary() {
    const transcript = buildTranscript(turnsRef.current);
    // Gate on what the USER said — the mentor's own greeting is in the transcript,
    // so without this a silent call still produced a fully hallucinated recap.
    const userSaid = turnsRef.current
      .filter((t) => t.role === "user")
      .map((t) => t.text)
      .join(" ")
      .trim();
    if (userSaid.length < 30) {
      setStatus("We didn't really get to talk — no recap this time. Call again whenever you're ready.");
      return;
    }
    setReview({ loading: true, summary: "", insights: [] });
    try {
      const res = await fetch("/api/mentor/summary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, transcript }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not summarize");
      if (json.silent) {
        setReview(null);
        setStatus("We didn't really get to talk — no recap this time.");
        return;
      }
      setReview({ loading: false, summary: json.summary ?? "", insights: json.insights ?? [] });
      void generateSuggestions(transcript);
    } catch (err) {
      setReview({
        loading: false,
        summary: "",
        insights: [],
        error: err instanceof Error ? err.message : "Summary failed",
      });
    }
  }

  // the mentor→résumé feedback loop: things worth adding, one-tap to accept
  async function generateSuggestions(transcript: string) {
    setSuggestLoading(true);
    try {
      const res = await fetch("/api/resume/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, transcript }),
      });
      const json = await res.json();
      if (res.ok) setSuggestions(json.suggestions ?? []);
    } catch {
      /* non-fatal — suggestions are a bonus */
    } finally {
      setSuggestLoading(false);
    }
  }
  async function addSuggestion(i: number) {
    const s = suggestions?.[i];
    if (!s) return;
    setSuggestions((list) => list?.map((x, idx) => (idx === i ? { ...x, status: "added" } : x)) ?? null);
    try {
      await fetch("/api/resume/suggest/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId,
          kind: s.kind,
          entryKind: s.entryKind,
          entryId: s.entryId,
          text: s.text,
        }),
      });
    } catch {
      /* leave marked; the résumé is source of truth */
    }
  }
  function dismissSuggestion(i: number) {
    setSuggestions((list) => list?.map((x, idx) => (idx === i ? { ...x, status: "dismissed" } : x)) ?? null);
  }

  // ---- review editing ----
  function editInsight(i: number, patch: Partial<Insight>) {
    setReview((r) =>
      r ? { ...r, insights: r.insights.map((x, idx) => (idx === i ? { ...x, ...patch } : x)) } : r,
    );
  }
  function removeInsight(i: number) {
    setReview((r) => (r ? { ...r, insights: r.insights.filter((_, idx) => idx !== i) } : r));
  }
  function addInsight() {
    setReview((r) =>
      r ? { ...r, insights: [...r.insights, { dimension: "goal", content: "", confidence: 0.6 }] } : r,
    );
  }
  async function saveReview() {
    if (!review) return;
    setSaveState("saving");
    setSaveMsg("Saving to your map…");
    try {
      const insights = review.insights.filter((i) => i.content.trim().length > 0);
      const res = await fetch("/api/mentor/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId,
          transcript: buildTranscript(turnsRef.current),
          insights,
          // the approved recap = what the mentor remembers next call
          summary: review.summary,
          durationSec: callStartRef.current ? Math.round((Date.now() - callStartRef.current) / 1000) : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      const n = json.count ?? insights.length;
      setSaveState("saved");
      setSaveMsg(`Saved ${n} insight${n === 1 ? "" : "s"} to your map ✓`);
    } catch (err) {
      setSaveState("error");
      setSaveMsg(err instanceof Error ? err.message : "Save failed");
    }
  }

  if (error) {
    return (
      <div className="upload-card">
        <h1>Can&apos;t start the call</h1>
        <p className="sub">{error}</p>
        <button className="btn" onClick={startSession}>
          Try again
        </button>
      </div>
    );
  }

  const orbClass =
    phase === "recording"
      ? "listening"
      : phase === "thinking"
        ? "thinking"
        : phase === "speaking"
          ? "speaking"
          : "ready";
  const label =
    phase === "recording"
      ? "I hear you…"
      : phase === "thinking"
        ? "Thinking…"
        : phase === "speaking"
          ? "Mentor is speaking"
          : "Listening — just start talking";
  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
  // the mentor's words STAY readable while the user speaks — accents shouldn't
  // cost anyone the thread; key terms (roles, companies, people) render bold
  const caption =
    phase === "speaking" && spokenText
      ? revealWords(spokenText, revealFrac)
      : lastAssistant?.text ?? "";
  const keyTerms = [
    ...spectrumRef.current.flatMap((r) => [r.title, r.company, displayCompany(r.company)]),
    ...circleRef.current.map((m) => m.name), // an offered person's name pops in the caption too
  ].filter((t): t is string => !!t && t.length > 2);

  return (
    <div className="call">
      <div className="call-topbar">
        <Brand />
        <span style={{ display: "flex", gap: 14, alignItems: "center" }}>
          {process.env.NODE_ENV !== "production" && (
            <>
              <button
                className="brain-toggle"
                onClick={() => {
                  setDebugOpen((v) => !v);
                  if (!health) void checkHealth();
                }}
                title="Debug: health of voicebox + Ollama + the client audio path"
              >
                🔧 Debug
              </button>
              <button
                className={`brain-toggle${brain === "anthropic" ? " cloud" : ""}`}
                onClick={() => setBrain((b) => (b === "ollama" ? "anthropic" : "ollama"))}
                title="Debug: which model answers the next turn (local Ollama vs Anthropic)"
              >
                {brain === "anthropic" ? "🧠 Claude" : "🏠 Local"}
              </button>
            </>
          )}
          {live ? (
            <button className="hangup" onClick={endSession}>
              End call
            </button>
          ) : (
            <a className="ghost-btn" href="/dashboard">← Dashboard</a>
          )}
          <UserChip />
        </span>
      </div>

      {debugOpen && process.env.NODE_ENV !== "production" && (
        <div className="debug-panel">
          <div className="debug-panel-head">
            <span>Voice stack health</span>
            <span className="debug-panel-actions">
              <button className="tip-add" onClick={() => void checkHealth()} disabled={healthBusy}>
                {healthBusy ? "Checking…" : "↻ Re-check"}
              </button>
              <button className="tip-add" onClick={testSpeaker}>🔊 Test speaker</button>
            </span>
          </div>
          {!health ? (
            <div className="debug-line">{healthBusy ? "Probing voicebox + Ollama…" : "No data — hit Re-check."}</div>
          ) : (
            <>
              <div className={`debug-line ${health.voicebox.up ? "ok" : "bad"}`}>
                {health.voicebox.up ? "●" : "○"} voicebox (STT+TTS): {health.voicebox.error ?? `healthy · ${health.voicebox.gpu} · ${health.voicebox.vramMb}MB VRAM`}
              </div>
              <div className={`debug-line ${health.ollama.up && health.ollama.liveModelPulled ? "ok" : "bad"}`}>
                {health.ollama.up ? "●" : "○"} ollama: {health.ollama.error ?? `up · ${health.ollama.models} models · ${health.config.liveModel} ${health.ollama.liveModelPulled ? "pulled" : "MISSING"}`}
              </div>
              <div className={`debug-line ${health.generation.ok ? "ok" : "bad"}`}>
                {health.generation.ok ? "●" : "○"} live turn ({health.config.liveModel}):{" "}
                {health.generation.error ?? `${health.generation.latencyMs}ms → “${health.generation.reply}”`}
                {(health.generation.latencyMs ?? 0) > 5000 && !health.generation.error && " — SLOW: model may be cold or thinking"}
              </div>
              <div className="debug-line">
                mentor brain: {brain === "anthropic" ? "anthropic (toggle)" : health.config.mentorProvider} · client audio:{" "}
                {lastAudioErrRef.current || "no errors this session"}
              </div>
              {lastTiming && <div className="debug-line">⏱ last turn: {lastTiming}</div>}
            </>
          )}
        </div>
      )}

      {!live && !review && (
        <div className="call-hero">
          <div className="hero-glow" aria-hidden />
          <VoiceOrb mode="ready" size={200} />
          <h1>Talk to your mentor</h1>
          <p className="sub">
            No buttons, no forms — just a conversation. Your mentor already knows
            your résumé; it listens for who you&apos;re becoming.
          </p>
          {queuePos !== null ? (
            <div className="call-queue">
              <div className="call-queue-pulse" />
              <div className="call-queue-line">Your mentor is with someone right now.</div>
              <div className="call-queue-pos">You&apos;re <b>#{queuePos}</b> in line — the call starts automatically.</div>
              <button
                className="ghost-btn"
                onClick={() => {
                  stopQueuePolling();
                  setQueuePos(null);
                  void laneCall("leave").catch(() => {});
                  setStatus("");
                }}
              >
                Leave the line
              </button>
            </div>
          ) : (
            <>
              <button className="btn call-cta" onClick={startSession}>
                Start the call
              </button>
            </>
          )}
          <div className="call-facts">
            <span>🎙 voice only</span>
            <span>⏱ 20 minutes</span>
            <span>🔒 stays on your machine</span>
          </div>
        </div>
      )}

      {live && (
        <div className="call-stage">
          <VoiceOrb mode={orbClass as "listening" | "thinking" | "speaking" | "ready"} levelRef={levelRef} size={300} />
          <div className="call-name">Your mentor</div>
          <div className={`call-timer${remaining <= 120 ? " low" : ""}`}>
            {fmtTime(remaining)} left
            {remaining <= 180 && remaining > 0 && (
              <button className="extend-btn" onClick={extendCall}>+5 min</button>
            )}
          </div>

          <div className="caption">
            <div className="caption-label">
              {phase === "thinking" ? (
                <span className="think-dots" aria-label="Thinking"><i /><i /><i /></span>
              ) : (
                label
              )}
            </div>
            {caption && <div className="caption-text" dangerouslySetInnerHTML={{ __html: renderCaption(caption, keyTerms) }} />}
          </div>

          {mentorCards && (
            <div className="call-roles">
              <div className="call-roles-head">From the drizzle circle — the one they just mentioned leads</div>
              <div className="call-roles-row">
                {mentorCards.map((m, i) => (
                  <div className={`call-role call-mentor${i === 0 ? " named" : ""}`} key={m.id} style={{ animationDelay: `${i * 120}ms` }}>
                    <div className="call-mentor-head">
                      {m.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img className="mentor-avatar" src={m.avatarUrl} alt="" />
                      ) : (
                        <span className="mentor-avatar mentor-avatar-fallback">{m.name.slice(0, 1)}</span>
                      )}
                      <div style={{ minWidth: 0 }}>
                        <div className="call-role-title">{m.name}</div>
                        <div className="call-role-co">{m.headline ?? ""}</div>
                      </div>
                    </div>
                    {m.move && <div className="call-mentor-move">{m.move}</div>}
                    {introState[m.id] === "sent" ? (
                      <span className="apply-confirm done">✓ Intro requested</span>
                    ) : (
                      <button className="tip-add" onClick={() => void requestIntroInCall(m.id)} disabled={introState[m.id] === "sending"}>
                        {introState[m.id] === "sending" ? "Requesting…" : "🤝 Request intro"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {roleCards && (
            <div className="call-roles">
              <div className="call-roles-head">Which of these pulls at you? <span className="call-roles-hint">tap one to explore it</span></div>
              <div className="call-roles-row">
                {roleCards.map((r, i) => (
                  <div
                    className="call-role call-role-btn"
                    key={i}
                    style={{ animationDelay: `${i * 120}ms` }}
                    role="button"
                    tabIndex={0}
                    title={`Explore ${r.title} at ${displayCompany(r.company)}`}
                    onClick={() => sendCardDive(r)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        sendCardDive(r);
                      }
                    }}
                  >
                    <span className="call-role-kind">{r.kind}</span>
                    <div className="call-role-title">{r.title}</div>
                    <div className="call-role-co">{displayCompany(r.company)}</div>
                    <div className="call-role-cta">Explore this path →</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {turns.length > 0 && (
            <>
              <button className="link-btn" onClick={() => setShowTranscript((v) => !v)}>
                {showTranscript ? "Hide transcript" : "Show transcript"}
              </button>
              {showTranscript && (
                <div className="transcript" ref={transcriptRef}>
                  {turns.map((t, i) => (
                    <div key={i} className={`bubble ${t.role}`}>
                      <span className="say">{t.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {review && (
        <div className="review">
          <h2>Your recap</h2>
          {review.loading ? (
            <ProcessingSteps />
          ) : review.error ? (
            <p className="status-line error">{review.error}</p>
          ) : (
            <>
              <textarea
                className="f recap"
                rows={Math.max(4, review.summary.split("\n").length + 1)}
                value={review.summary}
                onChange={(e) => setReview((r) => (r ? { ...r, summary: e.target.value } : r))}
              />

              <h2>What the mentor took away</h2>
              <p className="sub">
                Fix anything it got wrong — these become your map. Empty rows are skipped.
              </p>
              <div className="insight-list">
                {review.insights.map((ins, i) => (
                  <div className="insight-row" key={i}>
                    <select
                      className="f dim"
                      value={ins.dimension}
                      onChange={(e) => editInsight(i, { dimension: e.target.value })}
                    >
                      {DIMENSIONS.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                    <input
                      className="f"
                      value={ins.content}
                      placeholder="what the mentor understood…"
                      onChange={(e) => editInsight(i, { content: e.target.value })}
                    />
                    <button className="x" onClick={() => removeInsight(i)} title="Remove">
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button className="ghost-btn" onClick={addInsight}>
                + Add something
              </button>

              {(suggestLoading || (suggestions && suggestions.length > 0)) && (
                <div className="suggest-block">
                  <h2>Add to your résumé</h2>
                  <p className="sub">
                    Things you mentioned on the call that aren&apos;t on your résumé yet — one tap to add.
                  </p>
                  {suggestLoading && !suggestions && (
                    <p className="sub">Finding résumé-worthy moments from the call…</p>
                  )}
                  <div className="suggest-list">
                    {suggestions?.map((s, i) => (
                      <div className={`suggest-row ${s.status ?? ""}`} key={i}>
                        <div className="suggest-main">
                          <span className="suggest-kind">
                            {s.kind === "skill" ? "Skill" : s.entryLabel ?? "Bullet"}
                          </span>
                          <div className="suggest-text">{s.text}</div>
                          {s.rationale && <div className="suggest-why">{s.rationale}</div>}
                        </div>
                        {s.status === "added" ? (
                          <span className="suggest-added">Added ✓</span>
                        ) : s.status === "dismissed" ? (
                          <span className="suggest-dismissed">Dismissed</span>
                        ) : (
                          <div className="suggest-actions">
                            <button
                              className="suggest-add"
                              disabled={s.kind === "bullet" && !s.entryId}
                              title={s.kind === "bullet" && !s.entryId ? "Couldn't match a role — add it manually" : "Add to résumé"}
                              onClick={() => void addSuggestion(i)}
                            >
                              {s.kind === "bullet" && !s.entryId ? "No match" : "Add"}
                            </button>
                            <button className="suggest-dismiss" onClick={() => dismissSuggestion(i)}>
                              Dismiss
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="review-actions">
                <button
                  className="btn"
                  style={{ width: "auto", margin: 0, padding: "12px 28px" }}
                  onClick={saveReview}
                  disabled={saveState === "saving"}
                >
                  {saveState === "saving" ? "Saving…" : "Save to my map"}
                </button>
                <a className="ghost-btn" href="/resume">
                  Back to résumé →
                </a>
                <a className="ghost-btn" href="/debug" target="_blank" rel="noreferrer">
                  Debug: scores & insights ↗
                </a>
                <span className={`status-line ${saveState === "error" ? "error" : ""}`}>
                  {saveMsg}
                </span>
                {saveState === "saved" && (
                  // the payoff hop: the call just retuned the list — send them to it
                  <a className="btn" href="/dashboard?retuning=1" style={{ width: "auto", margin: 0, padding: "12px 28px", textDecoration: "none" }}>
                    See your updated matches →
                  </a>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function fmtTime(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function revealWords(text: string, frac: number): string {
  const words = text.split(" ");
  const n = Math.max(1, Math.ceil(frac * words.length));
  return words.slice(0, n).join(" ");
}

// Decode the recorded blob and re-encode as 16kHz mono 16-bit PCM WAV — the
// format Whisper ingests without an ffmpeg step on the server.
async function toWav(blob: Blob, targetRate = 16000): Promise<Blob> {
  const arr = await blob.arrayBuffer();
  const AC: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(arr);
    const chs = decoded.numberOfChannels;
    const len = decoded.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < chs; c++) {
      const d = decoded.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += d[i] / chs;
    }
    // linear resample to targetRate
    const ratio = decoded.sampleRate / targetRate;
    const outLen = Math.max(1, Math.floor(len / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = i * ratio;
      const i0 = Math.floor(idx);
      const i1 = Math.min(i0 + 1, len - 1);
      const frac = idx - i0;
      out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
    }
    // WAV container
    const buf = new ArrayBuffer(44 + outLen * 2);
    const view = new DataView(buf);
    const str = (o: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
    };
    str(0, "RIFF");
    view.setUint32(4, 36 + outLen * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, "data");
    view.setUint32(40, outLen * 2, true);
    let off = 44;
    for (let i = 0; i < outLen; i++) {
      const s = Math.max(-1, Math.min(1, out[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
    return new Blob([buf], { type: "audio/wav" });
  } finally {
    void ctx.close();
  }
}

function pickMime(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "audio/webm";
}
