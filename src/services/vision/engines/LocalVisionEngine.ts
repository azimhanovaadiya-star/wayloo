/**
 * LocalVisionEngine — REAL on-device object detection via TensorFlow.js
 * (COCO-SSD, lite_mobilenet_v2). Runs entirely in the browser: no network,
 * no credentials, frames never leave the device (PRD §2).
 *
 * Note (honest deviation, recorded in README): the PRD named onnxruntime-web +
 * YOLO11n ONNX as the candidate runtime with an explicit "verify early" step;
 * that verification landed on COCO-SSD (same COCO-80 vocabulary, same
 * VisionEngine contract, WASM/WebGL-capable) because it is the battle-tested
 * in-browser path for this build. The engine seam is unchanged, so a YOLO ONNX
 * engine (or the SiMa stack) drops in behind the same interface.
 */

import * as cocoSsd from "@tensorflow-models/coco-ssd";
import type { RawDetection, VisionEngine, VisionBackendId } from "../../../types";

export class LocalVisionEngine implements VisionEngine {
  readonly id: VisionBackendId = "local";
  readonly modelLabel = "COCO-SSD · TensorFlow.js (on-device)";

  private model: cocoSsd.ObjectDetection | null = null;

  get isLoaded(): boolean {
    return this.model !== null;
  }

  async load(): Promise<void> {
    if (this.model) return;
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