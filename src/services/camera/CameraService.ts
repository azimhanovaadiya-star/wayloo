/**
 * CameraService — getUserMedia lifecycle + frame geometry.
 * Audio is handled separately by SpeechService.
 *
 * Concurrency: start()/stop() are guarded by a monotonic attempt token so that
 * overlapping activations (double-click on Start, rapid "Try again", or a
 * quit while the permission prompt is up) never run two streams against the
 * same media element. An older attempt that loses the race releases its
 * stream and resolves quietly instead of throwing — reassigning one attempt's
 * `srcObject` over another's pending play() is what produced the browser
 * error "The play() request was interrupted by a new load request".
 */

export class CameraService {
  private stream: MediaStream | null = null;
  /** Monotonic token: every start()/stop() bumps it. An in-flight attempt that
   * no longer matches is superseded and must not touch the video element. */
  private attempt = 0;

  /** Request the camera. Throws with a human-readable message on failure. */
  async start(video: HTMLVideoElement): Promise<void> {
    console.log("[WAYLO CAMERA] start() called");
    if (!navigator.mediaDevices?.getUserMedia) {
      console.error("[WAYLO CAMERA] getUserMedia unavailable");
      throw new Error("Camera access is not supported in this browser.");
    }
    console.log("[WAYLO CAMERA] requesting permission...");
    // Detach any previous stream FIRST, then claim the attempt — stop() bumps
    // the token, so the fresh attempt must be captured after it.
    this.stop(video);
    const attempt = ++this.attempt;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      // A newer start() (or a stop() from quit/retry) began while we waited
      // for permission. Release this stream untouched — the newer attempt owns
      // the video element now.
      if (attempt !== this.attempt) {
        stream.getTracks().forEach((t) => t.stop());
        console.log("[WAYLO CAMERA] superseded while requesting — released unused stream");
        return;
      }
      this.stream = stream;
      video.srcObject = stream;
      try {
        await video.play();
      } catch (err) {
        // Attaching a newer srcObject reloads the media element, which aborts
        // our pending play() with "The play() request was interrupted by a new
        // load request". That is the newer attempt's show — not ours to throw.
        if (this.stream !== stream) {
          stream.getTracks().forEach((t) => t.stop());
          console.log("[WAYLO CAMERA] play() superseded — ignored");
          return;
        }
        throw err;
      }
      console.log("[WAYLO CAMERA] video playing", {
        width: video.videoWidth,
        height: video.videoHeight,
        readyState: video.readyState,
      });
    } catch (error) {
      console.error("[WAYLO CAMERA] FAILED:", error);
      throw error;
    }
  }

  /** True when both the stream and the video element are actively rendering. */
  isLive(video: HTMLVideoElement): boolean {
    return (
      this.stream !== null &&
      this.stream.active &&
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0
    );
  }

  get currentStream(): MediaStream | null {
    return this.stream;
  }

  /** Stop tracks and detach the video element. Safe to call anytime — also
   * invalidates any start() still awaiting a permission grant. */
  stop(video?: HTMLVideoElement): void {
    this.attempt++;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (video) video.srcObject = null;
  }
}

export const cameraService = new CameraService();