/**
 * SpeechService — the only module that knows anything about Speechmatics.
 * Everything else in the app calls `start({ onEvent, onFinal })` and receives
 * typed SpeechEvents (PRD §1 abstraction rule).
 *
 * Flow: fetch a fresh JWT from the Supabase Edge Function (the secret never
 * touches client code) → open the WebSocket → stream 16 kHz PCM from the mic.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { SpeechEvent } from "../../types";
import { STT_IDLE_TIMEOUT_MS, STT_LANGUAGE, STT_MAX_UTTERANCE_MS } from "../../constants";

const WS_ENDPOINT = "wss://eu.rt.speechmatics.com/v2";
const TARGET_RATE = 16000;

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
    throw new Error("Microphone access is not supported in this browser.");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

interface ActiveSession {
  ws: WebSocket;
  ctx: AudioContext;
  processor: ScriptProcessorNode;
  stream: MediaStream;
  onEvent: (e: SpeechEvent) => void;
  onFinal: (text: string, durationMs: number) => void;
  startedAt: number;
  gotAnything: boolean;
  tornDown: boolean;
  timers: ReturnType<typeof setTimeout>[];
}

function transcriptOf(msg: Record<string, unknown>): string {
  const meta = (msg.metadata ?? {}) as Record<string, unknown>;
  if (typeof meta.transcript === "string" && meta.transcript.trim()) return meta.transcript.trim();
  if (typeof msg.transcript === "string" && msg.transcript.trim()) return msg.transcript.trim();
  const results = msg.results;
  if (Array.isArray(results)) {
    return results
      .map((r) => {
        const row = r as { transcript?: string; alternatives?: Array<{ transcript?: string }> };
        return row.transcript ?? row.alternatives?.[0]?.transcript ?? "";
      })
      .join(" ")
      .trim();
  }
  return "";
}

export class SpeechService {
  private session: ActiveSession | null = null;

  get active(): boolean {
    return this.session !== null && !this.session.tornDown;
  }

  async start(opts: {
    onEvent: (e: SpeechEvent) => void;
    onFinal: (text: string, durationMs: number) => void;
  }): Promise<void> {
    await this.stop();

    const { token } = await fetchToken();
    const startedAt = performance.now();
    const ws = new WebSocket(`${WS_ENDPOINT}?jwt=${token}`);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Could not reach the speech service.")), 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
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

    const stream = await getMicStream();
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    await ctx.resume();
    ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(ctx.destination);

    const session: ActiveSession = {
      ws,
      ctx,
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
      if (this.session !== session || session.tornDown) return;
      const pcm = resample(e.inputBuffer.getChannelData(0));
      if (pcm.length > 0 && ws.readyState === WebSocket.OPEN) {
        ws.send(new Blob([pcm.buffer as ArrayBuffer], { type: "application/octet-stream" }));
      }
    };

    ws.onmessage = (ev) => {
      if (this.session !== session || session.tornDown) return;
      if (typeof ev.data !== "string") return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const kind = String(msg.message ?? msg.type ?? "");
      const text = transcriptOf(msg);

      if (/recognition-started/.test(kind)) {
        opts.onEvent({ type: "started" });
        return;
      }
      if (/partial/.test(kind) && text) {
        opts.onEvent({ type: "partial", text });
        return;
      }
      if (/transcript/i.test(kind) && text) {
        session.gotAnything = true;
        const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
        opts.onEvent({ type: "final", text, durationMs });
        opts.onFinal(text, durationMs);
        void this.stop();
        return;
      }
      if (kind === "error" || msg.error) {
        opts.onEvent({ type: "error", message: "The speech service reported a problem. Please try again." });
        void this.stop();
      }
    };

    ws.onclose = () => {
      if (this.session === session) this.teardown(session);
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
    try {
      session.processor.disconnect();
    } catch {
      /* noop */
    }
    session.stream.getTracks().forEach((t) => t.stop());
    void session.ctx.close().catch(() => undefined);
    try {
      if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
        session.ws.close();
      }
    } catch {
      /* noop */
    }
  }
}

/** Singleton — the app talks to one SpeechService instance. */
export const speechService = new SpeechService();