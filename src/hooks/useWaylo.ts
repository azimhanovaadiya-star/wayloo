/**
 * useWaylo — orchestrates the SEE → HEAR → UNDERSTAND → RESPOND loop.
 * All state lives here; components are dumb renders of this controller.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Scene, WayloError, WayloResponse, WayloState, WayloTurn } from "../types";
import { cameraService } from "../services/camera/CameraService";
import { speechService } from "../services/speech/SpeechService";
import { createVisionEngine } from "../services/vision/VisionEngine";
import type { VisionEngine } from "../services/vision/VisionEngine";
import { buildScene } from "../services/vision/scene";
import { synthesizeResponse } from "../services/ai/ReasoningEngine";
import { TtsEngine } from "../services/tts/TtsEngine";
import { sessionContext } from "../services/context/SessionContext";
import { PerformanceTracker } from "../services/metrics/PerformanceTracker";
import { DEMO_ANALYSIS_FPS } from "../constants";

export interface WayloController {
  screen: "start" | "main";
  wayloState: WayloState;
  partial: string;
  lastTurn: WayloTurn | null;
  lastScene: Scene | null;
  errors: WayloError[];
  demoMode: boolean;
  videoRef: { current: HTMLVideoElement | null };
  vision: { backend: VisionEngine["id"]; modelLabel: string; ready: boolean };
  live: { cameraOn: boolean; micUsable: boolean };
  ttsAvailable: boolean;
  start: () => Promise<void>;
  listen: () => Promise<void>;
  stopListening: () => Promise<void>;
  ask: (query: string) => Promise<void>;
  quit: () => Promise<void>;
  retryCamera: () => void;
  setDemoMode: (on: boolean) => void;
  dismissError: (id: number) => void;
}

function messageOf(err: unknown, fallback = "Something went wrong — please try again."): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** Human-readable guidance for a failed getUserMedia attempt. */
function cameraErrorMessage(err: unknown): string {
  const name = (err as DOMException | null)?.name ?? (err as Error | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera access was denied — allow it for this site, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No camera was found on this device — WAYLO still works with typed questions.";
  }
  const message = messageOf(err, "");
  if (message.includes("not supported")) return message;
  return "I couldn't start the camera right now — try again or use typed questions.";
}

export function useWaylo(): WayloController {
  const [screen, setScreen] = useState<"start" | "main">("start");
  const [wayloState, setWayloState] = useState<WayloState>("idle");
  const [partial, setPartial] = useState("");
  const [lastTurn, setLastTurn] = useState<WayloTurn | null>(null);
  const [lastScene, setLastScene] = useState<Scene | null>(null);
  const [errors, setErrors] = useState<WayloError[]>([]);
  const [demoMode, setDemoModeFlag] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraAttempt, setCameraAttempt] = useState(0);
  const [micUsable, setMicUsable] = useState(true);
  const [engineReady, setEngineReady] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<VisionEngine | null>(null);
  const busyRef = useRef(false);
  const ttsRef = useRef<TtsEngine | null>(null);
  const trackerRef = useRef(new PerformanceTracker());

  const getTts = useCallback((): TtsEngine => {
    if (!ttsRef.current) ttsRef.current = new TtsEngine();
    return ttsRef.current;
  }, []);

  const announce = useCallback(
    (message: string) => {
      void getTts().speak(message).catch(() => undefined);
    },
    [getTts]
  );

  const addError = useCallback(
    (kind: WayloError["kind"], message: string, opts: { speak?: boolean } = {}) => {
      setErrors((prev) => {
        if (prev.some((e) => e.message === message)) return prev;
        return [...prev, { kind, message, id: Date.now() + Math.random() }].slice(-3);
      });
      if (opts.speak !== false) void announce(message);
    },
    [announce]
  );

  const dismissError = useCallback((id: number) => {
    setErrors((prev) => prev.filter((e) => e.id !== id));
  }, []);

  /** The full SEE → HEAR → UNDERSTAND → RESPOND leg for one query. */
  const runQuery = useCallback(
    async (rawQuery: string, voice?: { tokenMs: number | null; sttMs: number | null }) => {
      const query = rawQuery.trim();
      if (!query || busyRef.current) return;
      busyRef.current = true;
      setPartial(query);
      setWayloState("analyzing");
      try {
        const video = videoRef.current;
        const engine = engineRef.current ?? (engineRef.current = createVisionEngine());
        if (!engine.isLoaded) await engine.load();
        setEngineReady(true);

        if (!video || !cameraService.isLive(video)) {
          throw new Error("I can't see anything — the camera isn't active. Restart WAYLO and allow camera access.");
        }

        const t0 = performance.now();
        const detections = await engine.analyse(video);
        const visionMs = Math.round(performance.now() - t0);

        const scene = buildScene(
          detections,
          video.videoWidth,
          video.videoHeight,
          engine.id,
          engine.modelLabel
        );
        setLastScene(scene);
        sessionContext.rememberScene(scene);

        const r0 = performance.now();
        const response: WayloResponse = synthesizeResponse(query, scene, {
          history: sessionContext.history,
        });
        const reasoningMs = Math.round(performance.now() - r0);

        const turn: WayloTurn = {
          query,
          response,
          scene,
          metrics: {
            tokenMs: voice?.tokenMs ?? null,
            sttMs: voice?.sttMs ?? null,
            visionMs,
            reasoningMs,
            ttsBeginMs: null,
          },
          at: new Date().toISOString(),
        };
        sessionContext.rememberTurn(turn);
        setLastTurn(turn);

        setWayloState("responding");
        const speakStart = performance.now();
        const tts = getTts();
        await tts.speak(response.text, () => {
          turn.metrics.ttsBeginMs = Math.round(performance.now() - speakStart);
          setLastTurn({ ...turn });
        });
        setWayloState("idle");
      } catch (err) {
        const message = messageOf(err);
        const kind: WayloError["kind"] =
          message.toLowerCase().includes("camera") || (err instanceof DOMException && err.name === "NotAllowedError")
            ? "camera"
            : "general";
        addError(kind, message);
        setWayloState("idle");
      } finally {
        busyRef.current = false;
      }
    },
    [addError, getTts]
  );

  /** Warm the vision model, then move to the main screen.
   * The camera itself starts in a mount effect once the <video> exists (see below). */
  const start = useCallback(async () => {
    const engine = engineRef.current ?? (engineRef.current = createVisionEngine());
    try {
      await engine.load();
      setEngineReady(true);
    } catch {
      addError("vision", "The on-device vision model couldn't load. Check your connection and try again.");
    }
    setScreen("main");
  }, [addError]);

  /** Voice input: Speechmatics → runQuery on the final transcript. */
  const listen = useCallback(async () => {
    if (busyRef.current || wayloState === "listening") return;
    setPartial("");
    setWayloState("listening");
    trackerRef.current.reset();
    trackerRef.current.begin("token");
    trackerRef.current.begin("stt");
    try {
      await speechService.start({
        onEvent: (e) => {
          if (e.type === "partial" && e.text) setPartial(e.text);
          if (e.type === "error") {
            setMicUsable(false);
            addError("stt", e.message);
          }
        },
        onFinal: (text) => {
          const tokenMs = trackerRef.current.ms("token");
          const sttMs = trackerRef.current.ms("stt");
          void runQuery(text, { tokenMs, sttMs });
        },
      });
    } catch (err) {
      const message = messageOf(
        err,
        "Voice recognition is temporarily unavailable. You can type your question below."
      );
      setMicUsable(false);
      addError(/microphone|blocked/i.test(message) ? "microphone" : "stt", message);
      setWayloState("idle");
    }
  }, [addError, runQuery, wayloState]);

  const stopListening = useCallback(async () => {
    await speechService.stop().catch(() => undefined);
    setWayloState((s) => (s === "listening" ? "idle" : s));
  }, []);

  const ask = useCallback(
    async (query: string) => {
      if (wayloState === "listening") await stopListening();
      await runQuery(query);
    },
    [wayloState, runQuery, stopListening]
  );

  const quit = useCallback(async () => {
    await speechService.stop().catch(() => undefined);
    getTts().cancel();
    cameraService.stop(videoRef.current ?? undefined);
    sessionContext.clear();
    setErrors([]);
    setLastTurn(null);
    setLastScene(null);
    setPartial("");
    setWayloState("idle");
    setScreen("start");
  }, [getTts]);

  const setDemoMode = useCallback((on: boolean) => {
    setDemoModeFlag(on);
  }, []);

  /** Re-attempt camera acquisition (from the "Try camera again" button). */
  const retryCamera = useCallback(() => {
    setCameraAttempt((n) => n + 1);
  }, []);

  // Camera startup: runs once the MainScreen <video> is mounted (screen === "main").
  // Previously this lived inside start(), where the video element didn't exist yet
  // (MainScreen mounts after setScreen("main")) — so the camera was never requested.
  useEffect(() => {
    if (screen !== "main" || cameraOn) return;
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      try {
        await cameraService.start(video);
        if (!cancelled && videoRef.current === video) setCameraOn(true);
      } catch (err) {
        if (cancelled) return;
        setCameraOn(false);
        addError("camera", cameraErrorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [screen, cameraOn, cameraAttempt, addError]);

  // Live camera watchdog while on the main screen.
  useEffect(() => {
    if (screen !== "main") return;
    const id = setInterval(() => {
      const video = videoRef.current;
      if (video) setCameraOn(cameraService.isLive(video));
    }, 1500);
    return () => clearInterval(id);
  }, [screen]);

  // Demo-mode live analysis loop (only when the user turns it on).
  useEffect(() => {
    if (screen !== "main" || !demoMode) return;
    const id = setInterval(async () => {
      if (busyRef.current) return;
      const video = videoRef.current;
      const engine = engineRef.current;
      if (!video || !engine?.isLoaded || !cameraService.isLive(video)) return;
      try {
        const detections = await engine.analyse(video);
        const scene = buildScene(
          detections,
          video.videoWidth,
          video.videoHeight,
          engine.id,
          engine.modelLabel
        );
        setLastScene(scene);
        sessionContext.rememberScene(scene);
      } catch {
        /* demo loop is best-effort */
      }
    }, 1000 / DEMO_ANALYSIS_FPS);
    return () => clearInterval(id);
  }, [screen, demoMode]);

  // Unmount safety.
  useEffect(() => {
    return () => {
      void speechService.stop().catch(() => undefined);
      getTts().cancel();
      cameraService.stop(videoRef.current ?? undefined);
    };
  }, [getTts]);

  const engine = engineRef.current;
  return {
    screen,
    wayloState,
    partial,
    lastTurn,
    lastScene,
    errors,
    demoMode,
    videoRef,
    vision: {
      backend: engine?.id ?? "local",
      modelLabel: engine?.modelLabel ?? "COCO-SSD · TensorFlow.js (on-device)",
      ready: engineReady,
    },
    live: { cameraOn, micUsable },
    ttsAvailable: getTts().available,
    start,
    listen,
    stopListening,
    ask,
    quit,
    retryCamera,
    setDemoMode,
    dismissError,
  };
}