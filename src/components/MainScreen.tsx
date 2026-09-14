/**
 * MainScreen — the running loop: camera preview, status, voice + typed input,
 * WAYLO's answer panel, and the honest demo/metrics view (demo mode only).
 *
 * Permission UX:
 *  - Tapping "Ask by voice" with no mic permission shows an explainer card
 *    ("WAYLO needs your microphone…") whose Allow button triggers the real
 *    getUserMedia prompt. Denials turn the card into exact recovery steps.
 *  - Question-asking (voice, typed, quick buttons) is disabled until the
 *    on-device vision model reports ready.
 */

import { useState } from "react";
import { Camera, Cpu, Gauge, Loader2, LogOut, Mic, MicOff, ShieldAlert, Square } from "lucide-react";
import type { WayloController } from "../hooks/useWaylo";
import type { Intent, LatencyMetrics } from "../types";
import { WayloLogo } from "./WayloLogo";
import { DebugOverlay } from "./DebugOverlay";
import { ErrorBanner } from "./ErrorBanner";

const QUICK_QUESTIONS = [
  "What's in front of me?",
  "Where is my phone?",
  "Is something in my way?",
  "What is this?",
];

const INTENT_LABEL: Record<Intent, string> = {
  SCENE_DESCRIPTION: "Scene description",
  FIND_OBJECT: "Find object",
  IDENTIFY_OBJECT: "Identify object",
  READ_TEXT: "Read text",
  SPATIAL_QUERY: "Where is it",
  OBSTACLE_QUERY: "Obstacle check",
  GENERAL_VISUAL_QUERY: "General",
};

const STATUS: Record<string, { label: string; hint: string }> = {
  idle: { label: "Ready — ask me anything", hint: "text-muted" },
  listening: { label: "Listening…", hint: "text-primary animate-listen" },
  analyzing: { label: "Understanding what I see…", hint: "text-primary" },
  responding: { label: "Speaking…", hint: "text-primary" },
};

export function MainScreen({ c }: { c: WayloController }) {
  const [typed, setTyped] = useState("");
  const video = c.videoRef.current;
  const videoSize = { w: video?.videoWidth ?? 0, h: video?.videoHeight ?? 0 };
  const status = STATUS[c.wayloState];
  const busy = c.wayloState === "analyzing" || c.wayloState === "responding";
  const visionReady = c.vision.ready;

  return (
    <div className="min-h-screen bg-background px-4 py-4 md:px-8">
      {/* Header */}
      <header className="flex items-center justify-between gap-3 max-w-3xl mx-auto">
        <div className="flex items-center gap-3">
          <WayloLogo size={40} />
          <span className="sr-only">WAYLO</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={c.demoMode}
            onClick={() => c.setDemoMode(!c.demoMode)}
            className={`chip ${c.demoMode ? "border-primary text-primary" : ""}`}
          >
            <Gauge className="h-5 w-5" aria-hidden="true" />
            {c.demoMode ? "Demo on" : "Demo"}
          </button>
          <button type="button" onClick={() => void c.quit()} className="btn-ghost !py-2 !px-4" aria-label="Exit to start screen">
            <LogOut className="h-5 w-5" aria-hidden="true" />
            Exit
          </button>
        </div>
      </header>

      {/* Status (voice-first: announced with text + icon, never color alone) */}
      <div className="max-w-3xl mx-auto mt-4" aria-live="assertive" aria-atomic="true">
        <div className="flex items-center gap-3 panel px-4 py-3">
          {c.wayloState === "listening" ? (
            <span className="h-3 w-3 rounded-full bg-primary animate-pulse-dot" aria-hidden="true" />
          ) : (
            <span className="h-3 w-3 rounded-full bg-muted/60" aria-hidden="true" />
          )}
          <span className={`font-heading font-semibold text-lg ${status.hint}`}>{status.label}</span>
          {!visionReady && (
            <span className="ml-auto inline-flex items-center gap-1.5 text-sm text-muted">
              <Loader2 className="spinner h-4 w-4 text-primary" aria-hidden="true" />
              Vision model loading…
            </span>
          )}
        </div>
      </div>

      <main className="max-w-3xl mx-auto mt-4 space-y-4">
        {/* Camera stage — the real <video> is ALWAYS mounted so videoRef stays valid
            and cameraService.start(videoRef.current) can attach the live stream. */}
        <div className="panel overflow-hidden">
          <div className="relative aspect-[4/3] bg-black">
            <video
              ref={c.videoRef}
              aria-label="Live camera feed"
              className="absolute inset-0 h-full w-full object-cover -scale-x-100"
              autoPlay
              playsInline
              muted
            />
            {c.demoMode && <DebugOverlay scene={c.lastScene} videoWidth={videoSize.w} videoHeight={videoSize.h} />}
            {/* state banner over video */}
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/80 to-transparent px-4 py-3">
              <p className="text-sm text-white/90">
                {c.wayloState === "listening" && c.partial
                  ? `“${c.partial}”`
                  : "Your surroundings — frames stay on this device."}
              </p>
              {c.wayloState === "listening" && (
                <span className="flex items-center gap-1.5 text-primary text-sm font-semibold animate-listen">
                  <Mic className="h-4 w-4" aria-hidden="true" />
                  Listening
                </span>
              )}
            </div>

            {/* Honest status overlay — the preview below stays mounted, never hidden. */}
            {!c.live.cameraOn && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center">
                <Camera className="h-10 w-10 text-muted" aria-hidden="true" />
                <p className="text-muted text-lg">
                  {c.live.cameraStarting ? "Starting your camera…" : "Camera isn't available right now."}
                </p>
                <p className="text-muted/80 text-sm max-w-sm">
                  {c.live.cameraStarting
                    ? "Allow camera access when your browser asks — frames never leave this device."
                    : "Check the browser permission, then retry. WAYLO still works with typed questions."}
                </p>
                {!c.live.cameraStarting && (
                  <button
                    type="button"
                    onClick={() => c.retryCamera()}
                    className="btn-ghost !py-2 !px-4 text-sm"
                    aria-label="Try starting the camera again"
                  >
                    <Camera className="h-4 w-4" aria-hidden="true" />
                    Try camera again
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <ErrorBanner errors={c.errors} onDismiss={c.dismissError} />

        <div className="grid gap-4 md:grid-cols-2">
          {/* What you said */}
          <section className="panel p-4" aria-labelledby="heard-title">
            <h2 id="heard-title" className="text-sm font-semibold uppercase tracking-wider text-muted">
              You said
            </h2>
            <p className="mt-2 text-xl text-foreground leading-snug min-h-[2.5rem]" aria-live="polite">
              {c.lastTurn?.query && c.wayloState !== "listening" ? c.lastTurn.query : c.partial || "…"}
            </p>
          </section>

          {/* WAYLO's answer */}
          <section className="panel p-4 border-primary/40" aria-labelledby="answer-title">
            <h2 id="answer-title" className="text-sm font-semibold uppercase tracking-wider text-primary-soft">
              WAYLO says
            </h2>
            <p className="mt-2 text-2xl text-foreground leading-snug min-h-[3rem]" aria-live="polite" aria-atomic="true">
              {(() => {
                if (!c.lastTurn) return "Ask your first question to see the answer here — and hear it aloud.";
                return c.lastTurn.response.text;
              })()}
            </p>
            {c.lastTurn && (
              <p className="mt-2 text-xs text-muted">
                {INTENT_LABEL[c.lastTurn.response.intent]}
                {c.lastTurn.response.isMiss ? " · not found (honest)" : ""}
                {c.ttsAvailable ? " · spoken aloud" : " · voice unavailable — shown on screen"}
              </p>
            )}
          </section>
        </div>

        {/* Mic permission explainer / recovery — shown until granted */}
        {(c.micPrompt || c.micStatus === "denied") && <MicPermissionCard c={c} />}

        {/* Voice + typed input */}
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Ask WAYLO">
            <button
              type="button"
              onClick={() => void (c.wayloState === "listening" ? c.stopListening() : c.listen())}
              disabled={busy || !visionReady}
              className={c.wayloState === "listening" ? "btn-ghost" : "btn-primary"}
              aria-label={c.wayloState === "listening" ? "Stop listening" : "Ask a question by voice"}
            >
              {c.wayloState === "listening" ? (
                <Square className="h-5 w-5" aria-hidden="true" />
              ) : (
                <Mic className="h-5 w-5" aria-hidden="true" />
              )}
              {c.wayloState === "listening" ? "Stop listening" : "Ask by voice"}
            </button>

            <form
              className="flex-1 flex gap-2 min-w-0"
              onSubmit={(e) => {
                e.preventDefault();
                if (typed.trim() && visionReady) {
                  void c.ask(typed);
                  setTyped("");
                }
              }}
            >
              <label htmlFor="typed-q" className="sr-only">
                Type your question
              </label>
              <input
                id="typed-q"
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                disabled={!visionReady}
                placeholder={
                  !visionReady
                    ? "Loading the vision model…"
                    : c.live.micUsable
                      ? "…or type a question"
                      : "Type your question (microphone is off)"
                }
                className="flex-1 min-w-0 panel !bg-surface-2 px-4 text-lg text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
              />
              <button
                type="submit"
                className="btn-ghost shrink-0 disabled:opacity-50"
                disabled={!visionReady}
                aria-label="Ask typed question"
              >
                Ask
              </button>
            </form>
          </div>

          {/* Quick questions (also voice-loop friendly for demos) */}
          <div className="flex flex-wrap gap-2" role="group" aria-label="Example questions">
            {QUICK_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => void c.ask(q)}
                className="chip disabled:opacity-50 disabled:pointer-events-none"
                disabled={!visionReady || busy}
              >
                {q}
              </button>
            ))}
          </div>
        </div>

        {c.demoMode && <DemoPanel c={c} />}
      </main>
    </div>
  );
}

/** Pre-permission explainer ("WAYLO needs your microphone to hear your
 * questions") or, once denied, exact recovery steps — never a dead-end error. */
function MicPermissionCard({ c }: { c: WayloController }) {
  const denied = c.micStatus === "denied";
  return (
    <div
      className="panel p-4 border-primary/40"
      role={denied ? "alert" : "region"}
      aria-live={denied ? "assertive" : "polite"}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          {denied ? (
            <ShieldAlert className="h-5 w-5 text-destructive" aria-hidden="true" />
          ) : (
            <Mic className="h-5 w-5 text-primary" aria-hidden="true" />
          )}
        </div>
        <div className="flex-1">
          <h3 className="font-heading font-semibold text-foreground text-lg">
            {denied ? "Microphone is blocked" : "WAYLO needs your microphone to hear your questions"}
          </h3>
          <p className="mt-1 text-sm text-muted leading-relaxed">
            {denied
              ? "Turn it on in your browser: tap the lock or “Site settings” icon next to the address bar → Microphone → Allow — then come back and try again. On a phone, also check Settings → Privacy → Microphone."
              : "Nothing is recorded or stored — audio is transcribed live and never leaves this device. You can always type instead."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void c.allowMic()}
              disabled={c.micStatus === "requesting"}
              className="btn-primary !py-2 !px-5 text-sm disabled:opacity-60"
            >
              {c.micStatus === "requesting" ? (
                <>
                  <Loader2 className="spinner h-4 w-4" aria-hidden="true" />
                  Requesting…
                </>
              ) : (
                <>
                  {denied ? <MicOff className="h-4 w-4" aria-hidden="true" /> : <Mic className="h-4 w-4" aria-hidden="true" />}
                  {denied ? "Try microphone again" : "Allow microphone"}
                </>
              )}
            </button>
            {!denied && (
              <button type="button" onClick={c.dismissMicPrompt} className="btn-ghost !py-2 !px-5 text-sm">
                Not now
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Real backend labels + real measured latencies (demo mode only). */
function DemoPanel({ c }: { c: WayloController }) {
  const m: LatencyMetrics = c.lastTurn?.metrics ?? {
    tokenMs: null,
    sttMs: null,
    visionMs: null,
    reasoningMs: null,
    ttsBeginMs: null,
  };
  const cells: Array<[string, number | null]> = [
    ["Token", m.tokenMs],
    ["STT", m.sttMs],
    ["Vision", m.visionMs],
    ["Reason", m.reasoningMs],
    ["TTS begin", m.ttsBeginMs],
  ];
  return (
    <section className="panel p-4 space-y-3" aria-label="Demo diagnostics">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="flex items-center gap-1.5 border border-border rounded-full px-3 py-1.5 text-muted">
          <Cpu className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          Vision: {c.vision.modelLabel}
        </span>
        <span className="inline-flex items-center gap-1.5 border border-border rounded-full px-3 py-1.5 text-muted">
          <Gauge className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          STT: Speechmatics (real-time)
        </span>
        <span className="inline-flex items-center gap-1.5 border border-border rounded-full px-3 py-1.5 text-muted">
          TTS: Web Speech API · backend: {c.vision.backend}
        </span>
      </div>

      <div className="grid grid-cols-5 gap-2">
        {cells.map(([name, ms]) => (
          <div key={name} className="rounded-lg bg-surface-2 px-2 py-2 text-center">
            <p className="text-[11px] uppercase tracking-wide text-muted">{name}</p>
            <p className="text-lg font-bold text-foreground">{ms === null ? "N/A" : `${ms} ms`}</p>
          </div>
        ))}
      </div>

      <div aria-label="Detected objects">
        <p className="text-[11px] uppercase tracking-wide text-muted mb-2">Scene ({c.lastScene?.objects.length ?? 0})</p>
        {c.lastScene && c.lastScene.objects.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {c.lastScene.objects.map((o, i) => (
              <li key={`${o.name}-${i}`} className="text-sm text-foreground/90 rounded-full border border-border px-3 py-1">
                {o.name} · {Math.round(o.confidence * 100)}% · {o.position}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No objects detected in the last frame.</p>
        )}
      </div>
    </section>
  );
}
