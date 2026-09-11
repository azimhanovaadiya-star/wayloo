/**
 * Pure scene assembly: raw detections → structured Scene.
 * Unit-tested in scene.test.ts.
 */

import type { DetectedObject, RawDetection, RelativePosition, Scene } from "../../types";
import { COCO_LABELS, MAX_DETECTIONS, MIN_OBJ_CONFIDENCE } from "../../constants";

/** [x, y, w, h] → [x1, y1, x2, y2] */
export function normalizeBox(box: [number, number, number, number]): [number, number, number, number] {
  const [x, y, w, h] = box;
  return [x, y, x + w, y + h];
}

/**
 * Map a box centroid to a relative position:
 *  - very top / very bottom of the frame wins first ("above" / "below"),
 *  - otherwise horizontal thirds → left / center / right.
 */
export function positionOfBox(
  box: [number, number, number, number],
  frameWidth: number,
  frameHeight: number
): RelativePosition {
  const [x1, y1, x2, y2] = box;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;

  if (frameHeight > 0 && cy < frameHeight / 4) return "above";
  if (frameHeight > 0 && cy > (3 * frameHeight) / 4) return "below";

  if (frameWidth <= 0) return "center";
  if (cx < frameWidth / 3) return "left";
  if (cx > (2 * frameWidth) / 3) return "right";
  return "center";
}

export function labelForClass(className: string): string {
  return COCO_LABELS[className] ?? className;
}

/** Filter, label, position, and prominence-sort raw detections into a Scene. */
export function buildScene(
  raw: RawDetection[],
  frameWidth: number,
  frameHeight: number,
  backend: Scene["backend"],
  modelLabel: string
): Scene {
  const objects: DetectedObject[] = raw
    .filter((d) => d.score >= MIN_OBJ_CONFIDENCE)
    .map((d) => {
      const bbox = normalizeBox(d.bbox);
      const [x1, y1, x2, y2] = bbox;
      return {
        name: labelForClass(d.className),
        confidence: d.score,
        bbox,
        position: positionOfBox(bbox, frameWidth, frameHeight),
        area: Math.max(0, (x2 - x1) * (y2 - y1)),
      };
    })
    .sort((a, b) => b.area * b.confidence - a.area * a.confidence)
    .slice(0, MAX_DETECTIONS);

  return {
    timestamp: new Date().toISOString(),
    objects,
    backend,
    modelLabel,
  };
}