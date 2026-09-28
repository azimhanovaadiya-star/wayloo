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
 *   → muted GainNode → AudioContext destination (muted, so the user is not
 *   echo-monitored). The source MUST be connected to the processor, otherwise
 *   onaudioprocess never receives any microphone samples.
 *
 * AudioContext lifecycle — WHY it is created in requestPermission() and NOT per
 * utterance (this is the one thing that silently broke voice):
 *   An AudioContext starts "suspended" unless it is created (and resumed) inside
 *   a user gesture. startSpeechmatics() runs an ASYNC sequence (Edge Function →
 *   WebSocket handshake → RecognitionStarted) before it ever creates audio, by
 *   which point Chrome's transient activation is gone — so a per-utterance
 *   `new AudioContext()` stayed suspended, `resume()` was rejected, and
 *   onaudioprocess NEVER fired → no audio captured, no PCM sent, no error logged,
 *   Speechmatics heard silence, and the UI fell into "I couldn't hear anything".
 *   Fix: the context is created and resumed inside the SAME gesture that grants
 *   microphone permission, kept on the service, and REUSED by every utterance.
 *   The context is only closed when the app releases the microphone.
 *
 * Diagnostics — pipeline markers are written to the console to make every stage
 * of MICROPHONE → AUDIO → JWT → WEBSOCKET → SPEECHMATICS inspectable:
 *   [MIC] GETUSERMEDIA_STARTED / PERMISSION_GRANTED / stream tracks & readyState
 *   [AUDIO] AudioContext rate + state, per-chunk non-zero% / peak (DEV, throttled),
 *           session-end byte totals — proof that real samples flowed
 *   [JWT] requesting token → token received (length only — the value is a secret)
 *   [WS] connecting → connected → message kinds → closed (code/reason)
 *   [SPEECHMATICS] transcription events → recognized text
 *   [ERROR] anything that failed, with the stage name
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
/** Bounded wait for the token function so the UI never hangs on a stalled service. */
const TOKEN_FETCH_TIMEOUT_MS = 15_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Always-visible pipeline diagnostics. Never logs tokens, URLs, or secrets. */
function log(...parts: unknown[]): void {
  console.log("[WAYLO Speech]", ...parts);
}
function warnLog(...parts: unknown[]): void {
  console.warn("[WAYLO Speech]", ...parts);
}

/** Stage-labelled diagnostic: [WAYLO Speech] [MIC] …, [AUDIO] …, [JWT] …,
 *  [WS] …, [SPEECHMATICS] …, [ERROR] …. */
function diag(stage: "MIC" | "AUDIO" | "JWT" | "WS" | "SPEECHMATICS" | "ERROR", ...parts: unknown[]): void {
  console.log(`[WAYLO Speech] [${stage}]`, ...parts);
}

/* ------------------------------------------------------------------ */
/* Error model — mic-permission and recognition failures stay distinct */
/* ------------------------------------------------------------------ */

export type SpeechErrorKind = "permission" | "unavailable" | "network" | "stt";

export class SpeechError extends Error {
  readonly kind: SpeechErrorKind;
  constructor(kind: SpeechErrorKind, message: string, name: string = kind) {
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

/** Mint a fresh short-lived Speechmatics RT JWT via the Edge Function.
 *  Every failure path — a returned error OR a thrown fetch error — is normalized
 *  to a friendly SpeechError, so raw low-level text like "ReadTimeout" can never
 *  reach the UI banners or the TTS announcement. */
async function fetchToken(): Promise<{ token: string; ms: number }> {
  const t0 = performance.now();
  let client: SupabaseClient;
  try {
    client = getSupabase();
  } catch (err) {
    throw asSpeechError(err);
  }
  try {
    diag("JWT", "requesting recognition token from the Edge Function");
    const { data, error } = await client.functions.invoke<{ token?: string }>("speechmatics-token", {
      body: {},
      timeout: TOKEN_FETCH_TIMEOUT_MS,
    });
    const ms = Math.round(performance.now() - t0);
    if (error) {
      const status = (error as { context?: { status?: number } }).context?.status;
      warnLog("[JWT] Token fetch failed (status", status ?? "n/a", ")");
      // 5xx (upstream timeouts, rate limits, function stall) → network-kind so
      // start() falls back to the browser engine instead of hard-failing.
      const kind: SpeechErrorKind = status !== undefined && status >= 500 ? "network" : "stt";
      throw new SpeechError(
        kind,
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
    // Log length/segments ONLY — the token value is a credential and never logged.
    diag("JWT", `token received in ${ms}ms (${data.token.length} chars, ${data.token.split(".").length} segments)`);
    return { token: data.token, ms };
  } catch (err) {
    // Normalize ANY thrown failure (abort/timeout, network drop, malformed
    // response). The token step runs before any speech is heard, so treat it as
    // network-kind to let the browser fallback engine take over downstream.
    if (err instanceof SpeechError) throw err;
    warnLog("[JWT] Token fetch threw:", err instanceof Error ? err.name : typeof err);
    throw new SpeechError(
      "network",
      "Speech recognition is temporarily unavailable — please try again in a moment.",
      "TokenError"
    );
  }
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
  diag("MIC", label, `— ${tracks.length} audio track(s)`);
  for (const track of tracks) {
    diag(
      "MIC",
      `  track: readyState=${track.readyState} enabled=${track.enabled} muted=${track.muted} label="${track.label}"`
    );
  }
}

/** Report the browser's permission-store state for the mic (best-effort). */
async function logMicPermissionState(): Promise<void> {
  try {
    const nav = navigator as Navigator & {
      permissions?: { query: (d: { name: string }) => Promise<{ state: string }> };
    };
    if (nav.permissions?.query) {
      const s = await nav.permissions.query({ name: "microphone" });
      diag("MIC", `permission store state: "${s.state}" (prompt/granted/denied)`);
    }
  } catch {
    /* Permissions API not available (some browsers) — skip silently */
  }
}

async function getMicStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new SpeechError("unavailable", "Microphone access is not supported in this browser.", "NotSupportedError");
  }
  try {
    diag("MIC", "GETUSERMEDIA_STARTED — requesting microphone (audio: mono, echoCancellation, noiseSuppression)");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    diag("MIC", "PERMISSION_GRANTED — Microphone permission granted");
    logMicStream(stream, "STREAM_STARTED — Microphone stream started");
    return stream;
  } catch (err) {
    const name = err instanceof DOMException ? err.name : err instanceof Error ? err.name : "UnknownError";
    diag("ERROR", `Microphone access failed: ${name}`);
    throw new SpeechError(micFailureKind(name), micFailureMessage(name), name);
  }
}

/* ------------------------------------------------------------------ */
/* Web Speech API (browser fallback engine) support                    */
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

/** Web Speech `error` code → user-safe mapping (name preserved for the UI). */
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
  /** One AudioContext for the whole app session, created+resumed inside the
   *  USER GESTURE that granted the mic (see module doc — why this exists). */
  private audioCtx: AudioContext | null = null;

  /** Create (once) or reuse the shared AudioContext. See the module docs: creating
   *  it per utterance — after the async token/WebSocket work — left it suspended
   *  and silently killed the microphone path, because onaudioprocess only fires
   *  on a RUNNING context and Chrome refuses resume() without a fresh user
   *  gesture. Called inside requestPermission() (a user gesture) so the context
   *  starts running then and is reused by every subsequent utterance. */
  private async warmAudioContext(): Promise<AudioContext> {
    let ctx = this.audioCtx;
    if (!ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        throw new SpeechError("unavailable", "This browser can't capture audio input.", "NotSupportedError");
      }
      ctx = new Ctor();
      this.audioCtx = ctx;
      diag("AUDIO", "AudioContext created", `(hardware rate ${ctx.sampleRate} Hz → ${TARGET_RATE} Hz stream)`);
    }
    // TS narrows ctx.state as we go ("running" already returned, "suspended"
    // handled), but resume() can genuinely move the runtime state to "running".
    // Re-read through a full-union cast so every branch of the state machine is
    // a real runtime check, not one TS has proven impossible.
    if ((ctx.state as AudioContextState) === "running") {
      diag("AUDIO", "AudioContext running — audio capture path live");
      return ctx;
    }
    if ((ctx.state as AudioContextState) === "suspended") {
      diag("AUDIO", "AudioContext is suspended — attempting resume() (needs a recent user gesture)");
      try {
        await ctx.resume();
      } catch (err) {
        diag("ERROR", "AudioContext resume() rejected:", err instanceof Error ? err.name : String(err));
      }
    }
    if ((ctx.state as AudioContextState) !== "running") {
      diag(
        "ERROR",
        `AudioContext did not start (state=${ctx.state}). No mic audio will be captured or sent. ` +
          "Re-run from a tap/click — the browser blocks suspended audio contexts outside a user gesture."
      );
      throw new SpeechError(
        "stt",
        "Your browser blocked the audio channel — tap the mic button again and speak.",
        "AudioContextBlockedError"
      );
    }
    return ctx;
  }

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
   *  the UI explains why WAYLO needs the mic before invoking this. The
   *  AudioContext is warmed in the SAME gesture so it can never silently end up
   *  suspended on a later utterance. */
  async requestPermission(): Promise<void> {
    // Warm the audio context BEFORE the async getUserMedia, inside the gesture.
    // If the browser still refuses, start() retries inside the listen gesture.
    try {
      await this.warmAudioContext();
    } catch {
      /* retried at start() */
    }
    void logMicPermissionState();
    if (this.micPermissionHeld) {
      diag("MIC", "permission already held — reusing live stream");
      return;
    }
    try {
      this.heldStream = await getMicStream();
    } catch (err) {
      const prepared = asSpeechError(err);
      if (prepared.name === "OverconstrainedError") {
        // A few devices reject specific audio constraints — fall back to defaults.
        try {
          this.heldStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          diag("MIC", "PERMISSION_GRANTED — Microphone permission granted (default constraints)");
          return;
        } catch {
          /* fall through to re-throw the original error */
        }
      }
      throw prepared;
    }
  }

  /** Stop and drop the held mic stream + the shared audio context (app session
   *  ending). The context is closed here, not per utterance. */
  releasePermission(): void {
    if (this.heldStream) {
      this.heldStream.getTracks().forEach((t) => t.stop());
      this.heldStream = null;
    }
    if (this.audioCtx && this.audioCtx.state !== "closed") {
      try {
        void this.audioCtx.close().catch(() => undefined);
      } catch {
        /* noop */
      }
      this.audioCtx = null;
    }
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
      warnLog("[ERROR] Speechmatics path failed before any speech —", first.message);
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
    const { token, ms } = await fetchToken(); // token value never logged
    diag("JWT", `token OK (${ms}ms) — opening WebSocket (region eu)`);

    const startedAt = performance.now();
    const ws = new WebSocket(`${WS_ENDPOINT}?jwt=${token}`); // URL never logged with the JWT
    ws.binaryType = "arraybuffer";
    diag("WS", `connecting to ${WS_ENDPOINT.replace("wss://", "")} (readyState=${ws.readyState})`);

    // Wait for the socket to open…
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        warnLog("[WS] WebSocket connect timed out — verify the Speechmatics region matches your API key");
        reject(new SpeechError("network", "Could not reach the speech service.", "NetworkError"));
      }, WS_CONNECT_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(timer);
        diag("WS", "CONNECTED — handshake OK (speech service reached)");
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        diag("ERROR", "WebSocket connection failed before it opened (see browser network/console for the real cause)");
        reject(new SpeechError("network", "Could not reach the speech service.", "NetworkError"));
      };
    });

    // Attach the start-phase message handler BEFORE sending start-recognition so
    // a fast RecognitionStarted (or an early server Error) can never be missed.
    let recognitionStarted = false;
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SpeechError("stt", "The speech service didn't respond.", "TimeoutError"));
      }, START_TIMEOUT_MS);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const fail = (e: SpeechError): void => {
        clearTimeout(timer);
        reject(e);
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
        diag("WS", "message:", kind);
        if (kind === "RecognitionStarted") {
          recognitionStarted = true;
          diag("SPEECHMATICS", "LISTENING — pending microphone audio");
          done();
          return;
        }
        if (kind === "Error") {
          warnLog("[SPEECHMATICS] start error:", errorDetail(msg));
          fail(new SpeechError("network", "The speech service couldn't start.", "SpeechmaticsError"));
          try {
            ws.close();
          } catch {
            /* noop */
          }
        }
      };
    });
    diag("WS", "sending start-recognition (pcm_s16le", `${TARGET_RATE} Hz, language ${STT_LANGUAGE})`);
    ws.send(
      JSON.stringify({
        type: "start-recognition",
        audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: TARGET_RATE },
        transcription_config: { language: STT_LANGUAGE, enable_partials: true, max_delay: 1 },
      })
    );
    await opened;

    // AudioContext: shared, created back in the permission gesture. If something
    // closed it since (or it never started), fail loudly instead of silently
    // capturing nothing (see module doc).
    const ctx = await this.warmAudioContext();
    diag("AUDIO", "AUDIO_CAPTURE_STARTED — audio capture path active");

    // Only now touch the microphone: reuse the held permission stream when
    // present (never prompt twice in one app session).
    let stream: MediaStream;
    try {
      stream = this.heldStream ?? (this.heldStream = await getMicStream());
      logMicStream(stream, "STREAM_STARTED — Microphone stream started");
    } catch (err) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      throw err;
    }
    diag("AUDIO", `started microphone capture at ${ctx.sampleRate} Hz (resampled to ${TARGET_RATE} Hz PCM16)`);

    // Build the muted audio graph. CRITICAL: the MediaStreamSourceNode is kept
    // and connected to the ScriptProcessor, otherwise onaudioprocess never fires.
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(ctx.destination);
    const resample = makeResampler(ctx.sampleRate);

    let session: SpeechmaticsSession | null = null;
    session = {
      engine: "speechmatics",
      ws,
      ctx,
      source,
      processor,
      stream,
      startedAt,
      gotAnything: false,
      endedSent: false,
      timers: [],
      tornDown: false,
      stop: async () => {
        const s = session;
        if (!s || s.tornDown) return;
        if (!s.endedSent && s.ws.readyState === WebSocket.OPEN) {
          s.endedSent = true;
          try {
            s.ws.send(JSON.stringify({ type: "end-of-stream" }));
            diag("WS", "end-of-stream sent — flushing final transcript");
          } catch {
            /* noop */
          }
        }
        await sleep(FINAL_FLUSH_MS);
        // Audio graph + mic teardown (the shared AudioContext stays open).
        if (s.stream !== this.heldStream) s.stream.getTracks().forEach((t) => t.stop());
        try {
          s.source.disconnect();
        } catch {
          /* noop */
        }
        try {
          s.processor.onaudioprocess = null;
          s.processor.disconnect();
        } catch {
          /* noop */
        }
        diag(
          "AUDIO",
          `session stopped — ${audioChunks} audio chunk(s), ${audioBytes} byte(s) PCM16 sent; ` +
            `last chunk non-zero ${(lastNonzeroFrac * 100).toFixed(0)}%, peak ${lastPeak.toFixed(3)}`
        );
        if (audioChunks === 0) {
          diag(
            "ERROR",
            "NO AUDIO WAS EVER SENT — onaudioprocess produced zero chunks. " +
              "Check the browser's audio-device, permissions and that the page was opened by a click/tap."
          );
        } else if (audioNonzero === 0) {
          diag("ERROR", "Audio reached the websocket but was ALL SILENT (zero non-zero samples). Check the mic device/routing.");
        }
        try {
          if (s.ws.readyState === WebSocket.OPEN || s.ws.readyState === WebSocket.CONNECTING) s.ws.close();
        } catch {
          /* noop */
        }
        this.teardown(s);
        opts.onEvent({ type: "ended" });
      },
    };

    // Per-session audio counters (evidence the user asked for):
    //  - chunk  = one ScriptProcessor callback (bufferSize 4096, ~85 ms at 48kHz);
    //  - nonZero = fraction of PCM samples that are not silence;
    //  - peak   = loudest sample, 0..1 (0.5+ means real speech-level volume);
    //  -	byte counters feed the end-of-session summary above.
    let chunkCount = 0;
    let bytesSent = 0;
    let audioChunks = 0;
    let audioBytes = 0;
    let audioNonzero = 0; // running count of non-zero PCM samples
    let lastNonzeroFrac = 0;
    let lastPeak = 0;

    // Make the session authoritative immediately, then run the live handlers.
    this.session = session;

    ws.onmessage = (ev) => {
      const s = session;
      if (!s || s.tornDown) return;
      if (typeof ev.data !== "string") return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const kind = typeof msg.message === "string" ? msg.message : "";
      diag("WS", "message:", kind);
      switch (kind) {
        case "AddPartialTranscript": {
          const text = transcriptOf(msg);
          if (text) {
            s.gotAnything = true;
            diag("SPEECHMATICS", `ADD_PARTIAL_TRANSCRIPT: "${text}"`);
            opts.onEvent({ type: "partial", text });
          }
          break;
        }
        case "AddTranscript": {
          const text = transcriptOf(msg);
          if (text) {
            s.gotAnything = true;
            diag("SPEECHMATICS", `RECOGNIZED: "${text}"`);
            log(`Transcript: "${text}"`);
            const durationMs = Math.max(0, Math.round(performance.now() - s.startedAt));
            opts.onEvent({ type: "final", text, durationMs });
            opts.onFinal(text, durationMs);
          }
          void s.stop();
          break;
        }
        case "EndOfTranscript":
          void s.stop();
          break;
        case "Error": {
          warnLog("[SPEECHMATICS] runtime error:", errorDetail(msg));
          opts.onEvent({
            type: "error",
            message: "The speech service reported a problem. Please try again.",
            name: "SpeechmaticsError",
          });
          void s.stop();
          break;
        }
        default:
          break; // other control messages (AudioAdded, EndOfStream…) are ignored
      }
    };

    ws.onclose = (ev) => {
      const s = session;
      if (s && !s.tornDown) {
        diag("WS", `closed code=${ev.code}`, ev.reason ? `reason="${ev.reason}"` : "(no reason)");
        this.teardown(s);
      }
    };

    processor.onaudioprocess = (e) => {
      const s = session;
      if (!s || s.tornDown || !recognitionStarted) return;
      if (s.ws.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = resample(input);
      if (pcm.length === 0) return;
      // Proof-of-life: measure how much of this chunk is actual sound vs silence,
      // and how loud the loudest sample is.
      let nonzero = 0;
      let peak = 0;
      for (let i = 0; i < pcm.length; i++) {
        const v = pcm[i];
        if (v !== 0) nonzero++;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      const nonzeroFrac = pcm.length > 0 ? nonzero / pcm.length : 0;
      s.ws.send(pcm.buffer as ArrayBuffer);
      chunkCount++;
      bytesSent += pcm.byteLength;
      audioChunks = chunkCount;
      audioBytes = bytesSent;
      audioNonzero += nonzero;
      lastNonzeroFrac = nonzeroFrac;
      lastPeak = peak;
      if (import.meta.env.DEV && chunkCount % 12 === 0) {
        // ~once a second at 48 kHz — loud enough to SEE the voice, quiet enough
        // not to drown the console.
        diag(
          "AUDIO",
          `chunk #${chunkCount}: ${input.length} samples in → ${pcm.length} PCM16 @16kHz ` +
            `(non-zero ${(nonzeroFrac * 100).toFixed(0)}%, peak ${peak.toFixed(3)}, ` +
            `${bytesSent} bytes total sent)`
        );
      }
    };

    // Timing gates: silent-gap flush + hard utterance cap.
    session.timers.push(
      setTimeout(() => {
        const s = session;
        if (!s || s.tornDown || this.session !== s) return;
        if (s.gotAnything) {
          log("Heard speech but no final yet — flushing transcript");
          void s.stop();
        } else {
          warnLog("No speech heard within the idle window");
          opts.onEvent({ type: "error", message: "I couldn't hear anything — please try again.", name: "no-speech" });
          void s.stop();
        }
      }, STT_IDLE_TIMEOUT_MS + 3000),
      setTimeout(() => {
        const s = session;
        if (s && !s.tornDown && this.session === s) void s.stop();
      }, STT_MAX_UTTERANCE_MS)
    );

    opts.onEvent({ type: "started" });
    return session;
  }

  /* ---------------- Browser Web Speech fallback engine ---------------- */

  private async startBrowserSpeech(opts: StartOptions): Promise<BrowserSession> {
    const Ctor = getSpeechCtor();
    if (!Ctor) {
      throw new SpeechError(
        "stt",
        "Voice recognition isn't supported in this browser — use a current Chrome, Edge, or Safari, or type your question.",
        "NotSupportedError"
      );
    }

    // The held mic stream (if any) is only inspected for diagnostics — the
    // browser captures its own audio.
    if (this.heldStream) {
      logMicStream(this.heldStream, "STREAM_STARTED — Microphone stream available");
    }

    const recognition = new Ctor();
    recognition.lang = STT_LANGUAGE;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    const startedAt = performance.now();
    const session: BrowserSession = {
      engine: "browser",
      startedAt,
      recognition,
      speechSeen: false,
      timers: [],
      tornDown: false,
      stop: async () => {
        if (session.tornDown) return; // `session` is assigned before use
        this.teardown(session);
        try {
          recognition.abort();
        } catch {
          /* noop */
        }
        opts.onEvent({ type: "ended" });
      },
    };

    let startedFlag = false;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SpeechError("stt", "Speech recognition didn't start in time — please try again.", "TimeoutError"));
      }, BROWSER_START_TIMEOUT_MS);

      recognition.onstart = () => {
        startedFlag = true;
        clearTimeout(timer);
        diag("WS", "browser engine started (Web Speech) — Listening…");
        opts.onEvent({ type: "started" });
        resolve();
      };
      recognition.onerror = (ev) => {
        const code = String((ev as { error?: string }).error ?? "");
        if (session.tornDown && code === "aborted") return; // user stopped — not an error
        if (code === "aborted") return;
        const mapped = webSpeechErrName(code);
        warnLog("[SPEECHMATICS] web-Speech error:", code, "—", mapped.message);
        if (!startedFlag) {
          clearTimeout(timer);
          reject(new SpeechError(mapped.kind, mapped.message, mapped.name));
          return;
        }
        opts.onEvent({ type: "error", message: mapped.message, name: mapped.name });
        void session.stop();
      };

      // start() MUST be called before awaiting onstart — the browser fires
      // onstart only in response to start(), so awaiting first would deadlock.
      try {
        recognition.start();
      } catch (err) {
        clearTimeout(timer);
        reject(asSpeechError(err, "stt"));
      }
    });

    recognition.onresult = (ev) => {
      if (session.tornDown) return;
      const { results } = webSpeechResultOf(ev);
      let interim = "";
      let finalText = "";
      for (const r of results) {
        const text = r.transcript.trim();
        if (!text) continue;
        if (r.isFinal) finalText = finalText ? `${finalText} ${text}` : text;
        else interim = interim ? `${interim} ${text}` : text;
      }

      if (finalText) {
        session.speechSeen = true;
        diag("SPEECHMATICS", `RECOGNIZED (fallback): "${finalText}"`);
        log(`Transcript: "${finalText}"`);
        const durationMs = Math.max(0, Math.round(performance.now() - session.startedAt));
        opts.onEvent({ type: "final", text: finalText, durationMs });
        opts.onFinal(finalText, durationMs);
        void session.stop();
        return;
      }
      if (interim) {
        session.speechSeen = true;
        diag("SPEECHMATICS", `ADD_PARTIAL_TRANSCRIPT (fallback): "${interim}"`);
        opts.onEvent({ type: "partial", text: interim });
      }
    };

    this.session = session;

    // Timing gates mirror the Speechmatics engine.
    session.timers.push(
      setTimeout(() => {
        const s = session;
        if (s.tornDown || this.session !== s) return;
        if (!s.speechSeen) {
          warnLog("No speech heard within the idle window (browser engine)");
          opts.onEvent({ type: "error", message: "I couldn't hear anything — please try again.", name: "no-speech" });
        }
        void s.stop();
      }, STT_IDLE_TIMEOUT_MS + 3000),
      setTimeout(() => {
        const s = session;
        if (!s.tornDown && this.session === s) void s.stop();
      }, STT_MAX_UTTERANCE_MS)
    );

    return session;
  }
}

/** Singleton — the app talks to one SpeechService instance. */
export const speechService = new SpeechService();