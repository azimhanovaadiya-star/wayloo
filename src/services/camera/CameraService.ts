/**
 * CameraService — getUserMedia lifecycle + frame geometry.
 * Audio is handled separately by SpeechService.
 */

export class CameraService {
  private stream: MediaStream | null = null;

  /** Request the user-facing camera. Throws with a human-readable message on failure. */
  async start(video: HTMLVideoElement): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera access is not supported in this browser.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    this.stream = stream;
    video.srcObject = stream;
    await video.play().catch(() => undefined);
    // Occasionally readyState lags the play() promise on first attach.
    await new Promise<void>((resolve) => {
      if (video.readyState >= 2) return resolve();
      const check = () => (video.readyState >= 2 ? resolve() : setTimeout(check, 50));
      check();
    });
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

  /** Stop tracks and detach the video element. Safe to call anytime. */
  stop(video?: HTMLVideoElement): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (video) video.srcObject = null;
  }
}

export const cameraService = new CameraService();