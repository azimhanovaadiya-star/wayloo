/**
 * SpeechService — the only module that knows about speech providers.
 * Everything else in the app calls `start({ onEvent, onFinal })` and receives
 * typed SpeechEvents (PRD §1 abstraction rule).
 *
 * Engines (in priority order):
 *  1. Speechmatics RT v2 (primary) — fresh JWT from the Supabase Edge Function
 *     (the secret never touches client code) → WebSocket → 16 kHz mono PCM.
 *  2. Browser-native Web Speech API (fallback) — used ONLY when the Speechmatics
 *     path fails before any speech was heard (token fetch, WebSocket connect,
 *     early server error) and the browser exposes SpeechRecognition.
 *
 * Mic-permission state and speech-recognition state are kept strictly apart:
 *  - a speech-recognition error is NEVER reported as "Microphone access denied";
 *  - permission-denied / permission-granted / microphone-unavailable /
 *    listening / processing / error are distinct, honest states.
 *
 * Audio graph (Speechmatics) — the path that carries sound:
 *   microphone → MediaStreamAudioSourceNode → ScriptProcessorNode (onaudioprocess
 *   resamples each chunk to 16 kHz pcm_s16le and sends it over the WebSocket)
 *   → muted GainNode → AudioContext destination (muted so the user is not
 *   echo-monitored). The source MUST be connected to the processor, otherwise
 *   onaudioprocess never receives any microphone samples.
 *
 * Diagnostics — pipeline markers are written to the console with a stable
 * [WAYLO Speech] prefix so the live flow is inspectable:
 *   MIC_PERMISSION_GRANTED, MIC_STREAM_STARTED, AUDIO_CAPTURE_STARTED,
 *   WEBSOCKET_CONNECTED, AUDIO_CHUNK_SENT (dev builds only — too chatty for
 *   prod), TRANSCRIPTION_RECEIVED, TRANSCRIPT_TEXT.
 * No secrets, JWTs, or WebSocket URLs (which embed the JWT) are ever logged.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { SpeechEvent } from "../../types";
import { STT_IDLE_TIMEOUT_MS, STT_LANGUAGE, STT_MAX_UTTERANCE_MS } from "../../constants";

const WS_ENDPOINT = "wss://eu.rt.speechmatics.com/v2";
const TARGET_RATE = 16000;
const WS_CONNECT_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 10_000;
const BROWSER_START_TIMEOUT_MS = 8_000;
const FINAL_FLUSH_MS = 350;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Always-visible pipeline diagnostics. Never logs tokens, URLs, or secrets. */
function log(...parts: unknown[]): void {
  console.log("[WAYLO Speech]", ...parts);
}
function warnLog(...parts: unknown[]): void {
  console.warn("[WAYLO Speech]", ...parts);
}

/* ------------------------------------------------------------------ */
/* Error model — mic-permission and recognition failures stay distinct */
/* ------------------------------------------------------------------ */

export type SpeechErrorKind = "permission" | "unavailable" | "network" | "stt";

export class SpeechError extends Error {
  readonly kind: SpeechErrorKind;
  constructor(kind: SpeechErrorKind, message: string, name = kind) {
    super(message);
    this.name = name; // preserved so the UI can show exact recovery steps
    this.kind = kind;
  }
}

function asSpeechError(err: unknown, fallbackKind: SpeechErrorKind = "stt"): SpeechError {
  if (err instanceof SpeechError) return err;
  const name = err instanceof Error ? err.name : "UnknownError";
  const message = err instanceof Error ? err.message : String(err);
  return new SpeechError(fallbackKind, message, name);
}

/** Classify a getUserMedia failure name into an honest, UI-actionable kind. */
export function micFailureKind(name: string): SpeechErrorKind {
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "permission";
    case "NotFoundError":
    case "NotReadableError":
    case "NotSupportedError":
    case "OverconstrainedError":
      return "unavailable";
    default:
      return "stt";
  }
}

/** Human message per getUserMedia failure name. */
function micFailureMessage(name: string): string {
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access was denied. Allow microphone access in the browser and try again.";
    case "NotFoundError":
      return "No microphone was found on this device. Plug one in or check your device settings, then try again.";
    case "NotReadableError":
      return "Your microphone is being used by another app. Close that app and try again.";
    case "NotSupportedError":
      return "This browser doesn't support microphone input. Try a current version of Chrome, Edge, or Safari.";
    default:
      return "Microphone access failed. Check your browser's site permissions for this page, then try again.";
  }
}

/* ------------------------------------------------------------------ */
/* Supabase / token                                                    */
/* ------------------------------------------------------------------ */

let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (supabase) return supabase;
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !anonKey) {
    throw new SpeechError(
      "stt",
      "WAYLO is missing its Supabase configuration. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the project's Environment settings.",
      "ConfigurationError"
    );
  }
  supabase = createClient(url, anonKey);
  return supabase;
}

/** Mint a fresh short-lived Speechmatics RT JWT via the Edge Function. */
async function fetchToken(): Promise<{ token: string; ms: number }> {
  const t0 = performance.now();
  let client: SupabaseClient;
  try {
    client = getSupabase();
  } catch (err) {
    throw asSpeechError(err);
  }
  const { data, error } = await client.functions.invoke<{ token?: string }>("speechmatics-token", {
    body: {},
  });
  const ms = Math.round(performance.now() - t0);
  if (error) {
    warnLog(
      "Token fetch failed (status",
      (error as { context?: { status?: number } }).context?.status ?? "n/a",
      ")"
    );
    throw new SpeechError(
      "stt",
      "Speech recognition is temporarily unavailable. Please try again in a moment.",
      "TokenError"
    );
  }
  if (!data?.token) {
    throw new SpeechError(
      "stt",
      "Speech recognition is temporarily unavailable — the token service returned no key.",
      "TokenError"
    );
  }
  return { token: data.token, ms };
}

/* ------------------------------------------------------------------ */
/* Shared audio helpers                                                */
/* ------------------------------------------------------------------ */

/** Linear-interpolation resampler: sourceRate → 16 kHz, output Int16 PCM. */
function makeResampler(srcRate: number): (input: Float32Array) => Int16Array {
  const ratio = Math.max(srcRate / TARGET_RATE, 0.25);
  return (input: Float32Array): Int16Array => {
    const outLen = Math.min(Math.floor(input.length / ratio), 16_384);
    const out = new Int16Array(outLen);
    let pos = 0;
    for (let i = 0; i < outLen; i++) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = input[Math.min(idx, input.length - 1)];
      const b = input[Math.min(idx + 1, input.length - 1)];
      const v = a * (1 - frac) + b * frac;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      pos += ratio;
    }
    return out;
  };
}

/** Verify a live mic stream is actually usable before streaming begins. */
function logMicStream(stream: MediaStream, label: string): void {
  const tracks = stream.getAudioTracks();
  log(label, `— ${tracks.length} audio track(s)`);
  for (const track of tracks) {
    log(
      `  track: readyState=${track.readyState} enabled=${track.enabled} muted=${track.muted} label="${track.label}"`
    );
  }
}

async function getMicStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new SpeechError("unavailable", "Microphone access is not supported in this browser.", "NotSupportedError");
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    log("MIC_PERMISSION_GRANTED — Microphone permission granted");
    logMicStream(stream, "MIC_STREAM_STARTED — Microphone stream started");
    return stream;
  } catch (err) {
    const name = err instanceof DOMException ? err.name : err instanceof Error ? err.name : "UnknownError";
    warnLog("Microphone access failed:", name);
    throw new SpeechError(micFailureKind(name), micFailureMessage(name), name);
  }
}

/* ------------------------------------------------------------------ */
/* Web Speech API (fallback engine) support                            */
/* ------------------------------------------------------------------ */

/** Minimal typing — the Web Speech API surface we actually use. */
export interface WebSpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onend: (() => void) | null;
}

type WebSpeechCtor = new () => WebSpeechRecognitionLike;

export function browserSpeechSupported(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

function getSpeechCtor(): WebSpeechCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: WebSpeechCtor;
    webkitSpeechRecognition?: WebSpeechCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function webSpeechResultOf(event: unknown): {
  resultIndex: number;
  results: Array<{ isFinal: boolean; transcript: string }>;
} {
  const ev = event as {
    resultIndex?: number;
    results?: ArrayLike<{ isFinal?: boolean; [index: number]: { transcript?: string } }>;
  };
  const out: Array<{ isFinal: boolean; transcript: string }> = [];
  const list = ev.results;
  if (list) {
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      out.push({ isFinal: Boolean(item?.isFinal), transcript: item?.[0]?.transcript ?? "" });
    }
  }
  return { resultIndex: ev.resultIndex ?? 0, results: out };
}

/** Web Speech `error` code → SpeechError-ish mapping for the UI. */
function webSpeechErrName(code: string): { kind: SpeechErrorKind; name: string; message: string } {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return {
        kind: "permission",
        name: "NotAllowedError",
        message: "Microphone access is blocked. Turn on the microphone for this site, then try again.",
      };
    case "audio-capture":
      return {
        kind: "unavailable",
        name: "NotFoundError",
        message: "Your microphone isn't responding. Check it's connected, then try again.",
      };
    case "no-speech":
      return { kind: "stt", name: "no-speech", message: "I couldn't hear anything — please try again." };
    case "network":
      return { kind: "network", name: "NetworkError", message: "Speech recognition lost its connection — please try again." };
    case "aborted":
      return { kind: "stt", name: "aborted", message: "Speech recognition was interrupted." };
    default:
      return { kind: "stt", name: code || "SpeechRecognitionError", message: "Speech recognition failed — please try again." };
  }
}

/* ------------------------------------------------------------------ */
/* Wire-format parsers (Speechmatics v2)                               */
/* ------------------------------------------------------------------ */

interface WordResult {
  type?: string;
  content?: string;
  transcript?: string;
  alternatives?: Array<{ content?: string; transcript?: string; text?: string }>;
}

/**
 * Extract the recognition text from a Speechmatics v2 message. Handles both
 * the aggregated `metadata.transcript` form and raw word-level results
 * (`results[].alternatives[].content`).
 */
export function transcriptOf(msg: Record<string, unknown>): string {
  const metadata = (msg.metadata ?? {}) as Record<string, unknown>;
  if (typeof metadata.transcript === "string" && metadata.transcript.trim()) {
    return metadata.transcript.trim();
  }
  if (typeof msg.transcript === "string" && msg.transcript.trim()) {
    return msg.transcript.trim();
  }
  const results = msg.results;
  if (Array.isArray(results)) {
    const words: string[] = [];
    for (const r of results) {
      const row = r as WordResult;
      const alt = row.alternatives?.[0];
      const candidate = row.content ?? row.transcript ?? alt?.content ?? alt?.transcript ?? alt?.text ?? "";
      if (typeof candidate === "string" && candidate.trim()) words.push(candidate.trim());
    }
    if (words.length > 0) return words.join(" ").trim();
  }
  return "";
}

/** Safe (non-secret) description of a Speechmatics error message. */
function errorDetail(msg: Record<string, unknown>): string {
  const reason = typeof msg.reason === "string" ? msg.reason : undefined;
  const type = typeof msg.type === "string" ? msg.type : undefined;
  const code = typeof msg.code === "string" ? msg.code : undefined;
  return [type, code, reason].filter((v): v is string => Boolean(v)).join(" | ") || "unknown error";
}

/* ------------------------------------------------------------------ */
/* Session model                                                       */
/* ------------------------------------------------------------------ */

export interface StartOptions {
  onEvent: (e: SpeechEvent) => void;
  onFinal: (text: string, durationMs: number) => void;
}

interface ActiveSession {
  readonly engine: "speechmatics" | "browser";
  readonly startedAt: number;
  timers: ReturnType<typeof setTimeout>[];
  tornDown: boolean;
  stop(): Promise<void>;
}

interface SpeechmaticsSession extends ActiveSession {
  readonly engine: "speechmatics";
  ws: WebSocket;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  stream: MediaStream;
  gotAnything: boolean;
  endedSent: boolean;
}

interface BrowserSession extends ActiveSession {
  readonly engine: "browser";
  recognition: WebSpeechRecognitionLike;
  speechSeen: boolean;
}

export class SpeechService {
  private session: ActiveSession | null = null;
  /** Mic stream acquired via requestPermission() and reused across STT sessions
   *  so the browser permission prompt appears exactly once per app session. */
  private heldStream: MediaStream | null = null;

  get active(): boolean {
    return this.session !== null && !this.session.tornDown;
  }

  /** True while a live mic stream is held (permission already granted). */
  get micPermissionHeld(): boolean {
    return (
      this.heldStream !== null && this.heldStream.getAudioTracks().some((t) => t.readyState === "live")
    );
  }

  /** Explicitly acquire microphone permission BEFORE any speech-to-text call.
   *  Must run from a user gesture so the browser shows its permission dialog;
   *  the UI explains why WAYLO needs the mic before invoking this. */
  async requestPermission(): Promise<void> {
    if (this.micPermissionHeld) return;
    try {
      this.heldStream = await getMicStream();
    } catch (err) {
      const prepared = asSpeechError(err);
      if (prepared.name === "OverconstrainedError") {
        // A few devices reject specific audio constraints — fall back to defaults.
        try {
          this.heldStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          log("MIC_PERMISSION_GRANTED — Microphone permission granted (default constraints)");
          return;
        } catch {
          /* fall through to re-throw the original error */
        }
      }
      throw prepared;
    }
  }

  /** Stop and drop the held mic stream (app session ending). */
  releasePermission(): void {
    if (!this.heldStream) return;
    this.heldStream.getTracks().forEach((t) => t.stop());
    this.heldStream = null;
  }

  async start(opts: StartOptions): Promise<void> {
    await this.stop();

    // 1) Speechmatics is the primary engine. No mic prompt is fired until a
    //    session that can actually consume audio exists.
    try {
      const session = await this.startSpeechmatics(opts);
      this.session = session;
      return;
    } catch (err) {
      const first = asSpeechError(err);
      // Mic-level failures are final — no engine can work around them.
      if (first.kind === "permission" || first.kind === "unavailable") throw first;
      warnLog("Speechmatics path failed before any speech —", first.message);
      if (!browserSpeechSupported()) throw first;
    }

    // 2) Browser-native Web Speech API fallback.
    log("Speechmatics unavailable — falling back to the browser's built-in speech recognition");
    const session = await this.startBrowserSpeech(opts);
    this.session = session;
  }

  /** Gracefully end the current utterance, flush the final transcript, close. */
  async stop(): Promise<void> {
    const session = this.session;
    if (!session || session.tornDown) return;
    await session.stop();
  }

  private teardown(session: ActiveSession): void {
    if (session.tornDown) return;
    session.tornDown = true;
    if (this.session === session) this.session = null;
    session.timers.forEach(clearTimeout);
  }

  /* ---------------- Speechmatics (primary) ---------------- */

  private async startSpeechmatics(opts: StartOptions): Promise<SpeechmaticsSession> {
    const { token } = await fetchToken(); // never logged
    const startedAt = performance.now();

    log("Fetching recognition token OK — opening WebSocket");
    const ws = new WebSocket(`${WS_ENDPOINT}?jwt=${token}`);
    ws.binaryType = "arraybuffer";

    // Wait for the socket to open…
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        warnLog("WebSocket connect timed out — verify the Speechmatics region matches your API key");
        reject(new SpeechError("network", "Could not reach the speech service.", "NetworkError"));
      }, WS_CONNECT_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(timer);
        log("WEBSOCKET_CONNECTED — Speech recognition service reached");
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        warnLog("WebSocket connection failed before it opened");
        reject(new SpeechError("network", "Could not reach the speech service.", "NetworkError"));
      };
    });

    // Attach the start-phase message handler BEFORE sending start-recognition so
    // a fast RecognitionStarted (or an early Error) can never be missed.
    let recognitionStarted = false;
    let runtimeError: SpeechError | null = null;
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SpeechError("stt", "The speech service didn't respond.", "TimeoutError"));
      }, START_TIMEOUT_MS);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return;
        }
        const kind = typeof msg.message === "string" ? msg.message : "";
        if (kind === "RecognitionStarted") {
          recognitionStarted = true;
          log("RecognitionStarted — Listening…");
          done();
          return;
        }
        if (kind === "Error") {
          const detail = errorDetail(msg);
          warnLog("Speechmatics start error:", detail);
          runtimeError = new SpeechError("network", `The speech service couldn't start (${detail}).`, "SpeechmaticsError");
          fail(runtimeError);
          try {
            ws.close();
          } catch {
            /* noop */
          }
          return;
        }
        // Partial/final transcripts arriving extremely early are kept for the
        // runtime handler below (start() consuming them would drop them).
      };
    });
    ws.send(JSON.stringify({ type: "start-recognition", ... }));
    await opened;

    if (!recognitionStarted) {
      throw new SpeechError("network", "The speech service didn't start.", "SpeechmaticsError");
    }

    ...
  }
}