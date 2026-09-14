/**
 * LocalVisionEngine — REAL on-device object detection via TensorFlow.js
 * (COCO-SSD, lite_mobilenet_v2). Runs entirely in the browser: no network at
 * inference time, no credentials, frames never leave the device (PRD §2).
 *
 * The @tensorflow/tfjs union import is REQUIRED: it is what registers the
 * 'webgl'/'cpu' compute backends. Without it only tfjs-core is bundled and the
 * very first model operation throws "No backend found in registry" — the exact
 * failure this engine historically hit. ensureBackend() activates webgl (cpu
 * fallback) so model loading and inference always have a backend to run on.
 *
 * Model files are downloaded once on first load (~6 MB) and then served from
 * Cache Storage by public/sw.js, so after the first run the engine is fully
 * offline-capable (it never depends on a network at runtime once installed).
 *
 * Note (honest deviation, recorded in README): the PRD named onnxruntime-web +
 * YOLO11n ONNX as the candidate runtime with an explicit "verify early" step;
 * that verification landed on COCO-SSD (same COCO-80 vocabulary, same
 * VisionEngine contract, WASM/WebGL-capable) because it is the battle-tested
 * in-browser path for this build. The engine seam is unchanged, so a YOLO ONNX
 * engine (or the SiMa stack) drops in behind the same interface.
 */

import * as cocoSsd from "@tensorflow-models/coco-ssd";
import * as tf from "@tensorflow/tfjs";
import type { RawDetection, VisionEngine, VisionBackendId } from "../../../types";

/** Activate a compute backend, preferring WebGL with a CPU fallback.
 *  Without this step tfjs-core fails with "No backend found in registry". */
export async function ensureBackend(): Promise<string> {
  for (const name of ["webgl", "cpu"] as const) {
    try {
      await tf.setBackend(name);
      await tf.ready();
      return tf.getBackend();
    } catch {
      /* try the next backend */
    }
  }
  throw new Error("No TensorFlow.js compute backend is available in this browser.");
}

export class LocalVisionEngine implements VisionEngine {
  readonly id: VisionBackendId = "local";
  readonly modelLabel = "COCO-SSD · TensorFlow.js (on-device)";

  private model: cocoSsd.ObjectDetection | null = null;

  get isLoaded(): boolean {
    return this.model !== null;
  }

  async load(): Promise<void> {
    if (this.model) return;
    const backend = await ensureBackend(); // registers a backend before any model op
    if (import.meta.env.DEV) console.debug("[WAYLO Vision] backend:", backend);
    // lite_mobilenet_v2 = fastest COCO-SSD variant, tuned for live/laptop CPU.
    this.model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
  }

  async analyse(video: HTMLVideoElement): Promise<RawDetection[]> {
    if (!this.model) throw new Error("Vision engine not loaded — call load() first.");
    const predictions = await this.model.detect(video, 20, 0.4);
    return predictions.map((p) => ({
      bbox: p.bbox as [number, number, number, number], // [x, y, w, h]
      className: p.class,
      score: p.score,
    }));
  }
}
