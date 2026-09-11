/**
 * SiMaVisionEngine — the SiMa deployment path (PRD §2).
 * This build has no SiMa board, so this engine MUST stay honestly unavailable:
 * it throws at runtime and is never wired silently. When hardware arrives, the
 * real implementation goes behind this same interface (ONNX-exported model →
 * SiMa Pal toolchain → device inference → identical input/output contract).
 */

import type { RawDetection, VisionEngine, VisionBackendId } from "../../../types";

export class SiMaVisionEngine implements VisionEngine {
  readonly id: VisionBackendId = "sima";
  readonly modelLabel = "SiMa.ai (hardware) — not available on this device";

  private loaded = false;

  get isLoaded(): boolean {
    return this.loaded;
  }

  async load(): Promise<void> {
    throw new Error(
      "SiMa hardware is not available in this build. " +
        "Set VISION_BACKEND='local' to use the on-device browser engine."
    );
  }

  async analyse(_video: HTMLVideoElement): Promise<RawDetection[]> {
    throw new Error("SiMa hardware not available.");
  }
}