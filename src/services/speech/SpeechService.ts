/**
 * SpeechService — the only module that knows anything about Speechmatics.
 * Everything else in the app calls `start({ onEvent, onFinal })` and receives
 * typed SpeechEvents (PRD §1 abstraction rule).
 *
 * Flow: fetch a fresh JWT from the Supabase Edge Function (the secret never
 * touches client code) → open the WebSocket → wait for `RecognitionStarted` →
 * stream 16 kHz mono PCM from the mic.
 *
 * Audio graph — the path that actually carries sound to Speechmatics:
 *   microphone → MediaStreamAudioSourceNode → ScriptProcessorNode (onaudioprocess
 *   resamples each chunk to 16 kHz pcm_s16le and sends it over the WebSocket)
 *   → muted GainNode → AudioContext destination (muted so the user is not
 *   echo-monitored). The source MUST be connected to the processor, otherwise
 *   onaudioprocess never receives any microphone samples.
 *
 * Contains temporary development-only logging (console.debug, active only when
 * import.meta.env.DEV is true — stripped from production builds). It never
 * logs the JWT, the WebSocket URL (which embeds the JWT), or any secret.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { SpeechEvent } from "../../types";
import { STT_IDLE_TIMEOUT_MS, STT_LANGUAGE, STT_MAX_UTTERANCE_MS } from "../../constants";

const WS_ENDPOINT = "wss://eu.rt.speechmatics.com/v2";
const TARGET_RATE = 16000;

/** Dev-only diagnostics. Never logs URLs, tokens, or secrets. */
function devLog(...parts: unknown[]): void {
  if (import.meta.env.DEV) console.debug("[WAYLO Speech]", ...parts);
}

let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (supabase) return supabase;
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !anonKey) {
    throw new Error(
      "WAYLO is missing its Supabase configuration. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the project's Environment settings."
    );
  }
  supabase = createClient(url, anonKey);
  return supabase;
}

/** Mint a fresh short-lived Speechmatics RT JWT via the Edge Function. */
export async function fetchToken(): Promise<{ token: string; ms: number }> {
  const t0 = performance.now();
  const { data, error } = await getSupabase().functions.invoke<{ token?: string }>(
    "speechmatics-token",
    { body: {} }
  );
  const ms = Math.round(performance.now() - t0);
  if (error) {
    throw new Error("Speech recognition is temporarily unavailable. Please try again in a moment.");
  }
  if (!data?.token) {
    throw new Error("Speech recognition is temporarily unavailable — the token service returned no key.");
  }
  return { token: data.token, ms };
}

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

async function getMicStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    devLog("mic permission DENIED — getUserMedia unsupported");
    const e = new Error("Microphone access is not supported in this browser.");
    e.name = "NotSupportedError";
    throw e;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    devLog("mic permission GRANTED", `audio tracks: ${stream.getAudioTracks().length}`);
    return stream;
  } catch (err) {
    const name = err instanceof DOMException ? err.name : err instanceof Error ? err.name : "UnknownError";
    devLog("mic permission DENIED", name);
    const e = new Error("Microphone access was denied. Allow microphone access and try again.");
    e.name = name; // preserved so the UI can show precise recovery steps
    throw e;
  }
}

interface ActiveSession {
  ws: WebSocket;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  stream: MediaStream;
  onEvent: (e: SpeechEvent) => void;
  onFinal: (text: string, durationMs: number) => void;
  startedAt: number;
  gotAnything: boolean;
  tornDown: boolean;
  timers: ReturnType<typeof setTimeout>[];
}

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
   *  the UI explains why WAYLO needs the mic before invoking this. The held
   *  stream is reused by start(), so no second dialog appears later. */
  async requestPermission(): Promise<void> {
    if (this.micPermissionHeld) return;
    try {
      this.heldStream = await getMicStream();
    } catch (err) {
      if (err instanceof Error && err.name === "OverconstrainedError") {
        // A few devices reject specific audio constraints — fall back to defaults.
        try {
          this.heldStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          return;
        } catch {
          /* fall through to re-throw the original error */
        }
      }
      throw err;
    }
  }

  /** Stop and drop the held mic stream (app session ending). */
  releasePermission(): void {
    if (!this.heldStream) return;
    this.heldStream.getTracks().forEach((t) => t.stop());
    this.heldStream = null;
  }

  async start(opts: {
    onEvent: (e: SpeechEvent) => void;
    onFinal: (text: string, durationMs: number) => void;
  }): Promise<void> {
    await this.stop();

    const { token } = await fetchToken(); // never logged
    const startedAt = performance.now();
    const ws = new WebSocket(`${WS_ENDPOINT}?jwt=${token}`);
    ws.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Could not reach the speech service.")), 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        devLog("WebSocket OPENED");
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        devLog("WebSocket error — connection failed");
        reject(new Error("Could not reach the speech service."));
      };
    });

    ws.send(
      JSON.stringify({
        type: "start-recognition",
        audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: TARGET_RATE },
        transcription_config: { language: STT_LANGUAGE, enable_partials: true, max_delay: 1 },
      })
    );

    // `session`/`recognitionStarted` must exist before `ws.onmessage` is set so
    // a fast RecognitionStarted can never be missed while the mic is starting.
    let session: ActiveSession | null = null;
    let recognitionStarted = false;

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return; // server sends JSON only
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const kind = typeof msg.message === "string" ? msg.message : "";
      const text = transcriptOf(msg);

      switch (kind) {
        case "RecognitionStarted":
          // Gate: do not stream any mic audio until the session is live.
          recognitionStarted = true;
          devLog("RecognitionStarted received");
          break;

        case "AddPartialTranscript":
          devLog("AddPartialTranscript received", text ? `"${text}"` : "(no text yet)");
          if (!session || session.tornDown) return;
          if (text) opts.onEvent({ type: "partial", text });
          break;

        case "AddTranscript":
          devLog("AddTranscript received", text ? `"${text}"` : "(empty)");
          if (!session || session.tornDown) return;
          if (text) {
            session.gotAnything = true;
            const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
            opts.onEvent({ type: "final", text, durationMs });
            opts.onFinal(text, durationMs);
            void this.stop();
          }
          break;

        case "EndOfTranscript":
          devLog("EndOfTranscript received");
          break;

        case "Error":
          devLog("Speechmatics error:", errorDetail(msg));
          if (session) {
            opts.onEvent({ type: "error", message: "The speech service reported a problem. Please try again." });
            void this.stop();
          } else {
            try {
              ws.close();
            } catch {
              /* noop */
            }
          }
          break;

        default:
          // Unknown keep-alive / system messages are ignored.
          break;
      }
    };

    ws.onclose = () => {
      devLog("WebSocket CLOSED");
      if (session) this.teardown(session);
    };

    let stream: MediaStream;
    try {
      // Reuse the held permission stream when present (granted via
      // requestPermission) — never prompt twice in one app session.
      stream = this.heldStream ?? (this.heldStream = await getMicStream());
    } catch (err) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      throw err;
    }

    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    await ctx.resume();
    devLog("AudioContext sample rate:", ctx.sampleRate, "Hz");

    // Build the muted graph. CRITICAL: the MediaStreamSourceNode's return value
    // is stored and connected to the ScriptProcessor, otherwise the processor
    // never receives any microphone audio.
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(ctx.destination);

    session = {
      ws,
      ctx,
      source,
      processor,
      stream,
      onEvent: opts.onEvent,
      onFinal: opts.onFinal,
      startedAt,
      gotAnything: false,
      tornDown: false,
      timers: [],
    };
    this.session = session;

    const resample = makeResampler(ctx.sampleRate);
    processor.onaudioprocess = (e) => {
      if (!session || session.tornDown) return;
      if (!recognitionStarted) return; // no audio until RecognitionStarted
      const pcm = resample(e.inputBuffer.getChannelData(0));
      if (pcm.length === 0 || ws.readyState !== WebSocket.OPEN) return;
      ws.send(pcm.buffer as ArrayBuffer);
      devLog("PCM chunk sent:", pcm.byteLength, "bytes");
    };

    // Fallback timers: idle-silence gate + hard utterance cap.
    session.timers.push(
      setTimeout(() => {
        if (this.session === session && !session.gotAnything) {
          opts.onEvent({ type: "error", message: "I couldn't hear anything — please try again." });
          void this.stop();
        }
      }, STT_IDLE_TIMEOUT_MS + 3000),
      setTimeout(() => {
        if (this.session === session) void this.stop();
      }, STT_MAX_UTTERANCE_MS)
    );

    opts.onEvent({ type: "started" });
  }

  /** Gracefully end the current utterance, flush the final transcript, close. */
  async stop(): Promise<void> {
    const session = this.session;
    if (!session || session.tornDown) return;
    if (session.ws.readyState === WebSocket.OPEN) {
      try {
        session.ws.send(JSON.stringify({ type: "end-of-stream" }));
      } catch {
        /* noop */
      }
    }
    await new Promise((r) => setTimeout(r, 350));
    this.teardown(session);
  }

  private teardown(session: ActiveSession): void {
    if (session.tornDown) return;
    session.tornDown = true;
    if (this.session === session) this.session = null;
    session.timers.forEach(clearTimeout);

    // 1) Stop the microphone tracks — unless they belong to the held permission
    //    stream, which stays live for the rest of the app session.
    if (session.stream !== this.heldStream) {
      devLog("Stopping microphone tracks");
      session.stream.getTracks().forEach((t) => t.stop());
    }

    // 2) Disconnect the Web Audio graph: source then processor.
    try {
      session.source.disconnect();
    } catch {
      /* noop */
    }
    try {
      session.processor.onaudioprocess = null;
      session.processor.disconnect();
    } catch {
      /* noop */
    }

    // 3) Close the AudioContext.
    void session.ctx.close().catch(() => undefined);

    // 4) Close the WebSocket.
    try {
      if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
        devLog("Closing WebSocket");
        session.ws.close();
      }
    } catch {
      /* noop */
    }
  }
}

/** Singleton — the app talks to one SpeechService instance. */
export const speechService = new SpeechService();