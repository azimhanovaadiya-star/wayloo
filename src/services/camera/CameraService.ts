/**
 * CameraService — getUserMedia lifecycle + frame geometry.
 * Audio is handled separately by SpeechService.
 */

export class CameraService {
  private stream: MediaStream | null = null;

  /** Request the camera. Throws with a human-readable message on failure. */
  async start(video: HTMLVideoElement): Promise<void> {
    console.log("[WAYLO CAMERA] start() called");
    if (!navigator.mediaDevices?.getUserMedia) {
      console.error("[WAYLO CAMERA] getUserMedia unavailable");
      throw new Error("Camera access is not supported in this browser.");
    }
    console.log("[WAYLO CAMERA] requesting permission...");
    try {
      this.stop(video);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      console.log("[WAYLO CAMERA] permission granted", stream.getVideoTracks());
      this.stream = stream;
      video.srcObject = stream;
      await video.play();
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

  /** Stop tracks and detach the video element. Safe to call anytime. */
  stop(video?: HTMLVideoElement): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (video) video.srcObject = null;
  }
}

export const cameraService = new CameraService();