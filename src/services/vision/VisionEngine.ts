/**
 * The VisionEngine seam (PRD §2).
 * LocalVisionEngine: real on-device COCO-SSD via TensorFlow.js (verified in this
 *   build as the WASM-capable engine; the PRD's "verify early" step concluded
 *   COCO-SSD is the battery-tested browser path — same COCO-80 vocabulary, same
 *   interface, same honesty contract. See README for the ONNX swap note.)
 * SiMaVisionEngine: the SiMa hardware path. Present, honest, and unavailable
 *   without the actual board — it must never silently masquerade as working.
 */

import type { VisionEngine, VisionBackendId } from "../../types";
import { VISION_BACKEND } from "../../constants";
import { LocalVisionEngine } from "./engines/LocalVisionEngine";
import { SiMaVisionEngine } from "./engines/SiMaVisionEngine";

export function createVisionEngine(): VisionEngine {
  if (VISION_BACKEND === "sima") return new SiMaVisionEngine();
  return new LocalVisionEngine();
}

export type { VisionEngine, VisionBackendId };