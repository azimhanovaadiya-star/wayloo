/**
 * Landing / splash. Hero → how it works → CTA, black + amber, big targets.
 * Shows a visible loading state while the on-device vision model initializes,
 * and a Retry affordance if that one-time download fails.
 */

import { Lock, Mic, RefreshCw, Sparkles, Volume2 } from "lucide-react";
import { WayloLogo } from "./WayloLogo";
import type { VisionState } from "../hooks/useWaylo";

export function StartScreen({
  onStart,
  starting,
  visionState,
  onRetryVision,
}: {
  onStart: () => Promise<void>;
  /** True while the model is warming up + the camera prompt is pending — keeps
   * the Start button from spawning overlapping camera attempts. */
  starting: boolean;
  /** "loading" while the vision model downloads, "failed" if it couldn't. */
  visionState: VisionState;
  onRetryVision: () => Promise<void>;
}) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-12 bg-background">
      <main className="w-full max-w-2xl flex flex-col items-center text-center">
        <h1 className="sr-only">WAYLO — voice and vision companion</h1>

        <div className="mb-6" aria-hidden="true">
          <WayloLogo size={168} glow />
        </div>

        <p className="text-3xl md:text-5xl font-heading font-bold tracking-tight text-foreground leading-tight max-w-xl">
          See your surroundings.{" "}
          <span className="text-primary amber-glow-text">Hear them described.</span>
        </p>

        <p className="mt-5 text-lg text-muted max-w-xl leading-relaxed">
          WAYLO is a privacy-first companion for people with low vision. Ask a
          question out loud — “What's in front of me?” — and WAYLO sees with your
          camera, understands, and answers aloud. All on your device.
        </p>

        {/* How it works */}
        <section aria-label="How WAYLO works" className="mt-10 grid gap-4 w-full max-w-xl sm:grid-cols-3 text-left">
          <div className="panel p-5">
            <Sparkles className="h-6 w-6 text-primary" aria-hidden="true" />
            <h2 className="mt-3 font-heading font-bold text-foreground text-lg">1 · You ask</h2>
            <p className="mt-1 text-sm text-muted leading-snug">
              “What's in front of me?” or “Where is my phone?” — spoken or typed.
            </p>
          </div>
          <div className="panel p-5">
            <EyeMark />
            <h2 className="mt-3 font-heading font-bold text-foreground text-lg">2 · WAYLO sees</h2>
            <p className="mt-1 text-sm text-muted leading-snug">
              Object detection runs entirely in your browser — frames never leave the device.
            </p>
          </div>
          <div className="panel p-5">
            <Volume2 className="h-6 w-6 text-primary" aria-hidden="true" />
            <h2 className="mt-3 font-heading font-bold text-foreground text-lg">3 · WAYLO answers</h2>
            <p className="mt-1 text-sm text-muted leading-snug">
              A concise answer spoken aloud, and shown on screen. Never invented.
            </p>
          </div>
        </section>

        {visionState === "failed" ? (
          <div className="mt-10 flex flex-col items-center gap-4">
            <p className="max-w-md text-muted text-base leading-relaxed">
              WAYLO's on-device vision model didn't load. It's a one-time download
              (about 6 MB) — after that it works offline. Check your connection and
              try again.
            </p>
            <button
              type="button"
              onClick={() => void onRetryVision()}
              className="btn-primary text-xl"
              aria-label="Try loading the vision model again"
            >
              <RefreshCw className="h-6 w-6" aria-hidden="true" />
              Try loading vision again
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void onStart()}
            disabled={starting}
            aria-busy={starting}
            className="btn-primary mt-10 text-xl disabled:opacity-60 disabled:pointer-events-none"
            aria-label="Start WAYLO — loads the vision model, then enables camera and microphone"
          >
            {starting ? (
              <>
                <span className="spinner h-6 w-6 border-2 border-on-primary/40 border-t-on-primary rounded-full" aria-hidden="true" />
                Loading WAYLO's vision model…
              </>
            ) : (
              <>
                <Mic className="h-6 w-6" aria-hidden="true" />
                Start WAYLO
              </>
            )}
          </button>
        )}

        <p className="mt-4 flex items-center gap-2 text-sm text-muted">
          {starting ? (
            <span className="spinner h-4 w-4 border-2 border-primary/40 border-t-primary rounded-full" aria-hidden="true" />
          ) : (
            <Lock className="h-4 w-4 text-primary" aria-hidden="true" />
          )}
          {starting
            ? "Downloading the on-device vision model — one time, then it works offline."
            : "Frames & audio stay on this device. You'll be asked for camera and microphone access."}
        </p>

        <p className="mt-6 text-sm text-muted/80">
          Waylo is an assistive prototype — it does not replace a guide, caregiver, or emergency services.
        </p>
      </main>
    </div>
  );
}

function EyeMark() {
  return (
    <span className="inline-flex items-center justify-center h-6 w-6 text-primary" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6">
        <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </span>
  );
}
