/**
 * Unit tests for scene assembly (PRD §Testing): position mapping + filtering.
 */

import { describe, expect, it } from "vitest";
import { buildScene, labelForClass, normalizeBox, positionOfBox } from "./scene";
import type { RawDetection } from "../../types";

describe("normalizeBox", () => {
  it("converts [x, y, w, h] to [x1, y1, x2, y2]", () => {
    expect(normalizeBox([10, 20, 30, 40])).toEqual([10, 20, 40, 60]);
  });
});

describe("positionOfBox", () => {
  const W = 900;
  const H = 600;

  it("maps the left third to 'left'", () => {
    expect(positionOfBox([0, 200, 100, 400], W, H)).toBe("left");
  });
  it("maps the right third to 'right'", () => {
    expect(positionOfBox([700, 200, 800, 400], W, H)).toBe("right");
  });
  it("maps the middle to 'center'", () => {
    expect(positionOfBox([400, 200, 500, 400], W, H)).toBe("center");
  });
  it("maps the very top to 'above'", () => {
    expect(positionOfBox([400, 0, 500, 60], W, H)).toBe("above");
  });
  it("maps the very bottom to 'below'", () => {
    expect(positionOfBox([400, 560, 500, 600], W, H)).toBe("below");
  });
});

describe("labelForClass", () => {
  it("humanizes COCO names", () => {
    expect(labelForClass("cell phone")).toBe("phone");
    expect(labelForClass("dining table")).toBe("table");
    expect(labelForClass("person")).toBe("person");
  });
});

describe("buildScene", () => {
  it("filters low-confidence detections", () => {
    const raw: RawDetection[] = [
      { bbox: [0, 0, 100, 100], className: "bottle", score: 0.9 },
      { bbox: [200, 200, 60, 60], className: "cup", score: 0.2 }, // below threshold
    ];
    const scene = buildScene(raw, 900, 600, "local", "test");
    expect(scene.objects).toHaveLength(1);
    expect(scene.objects[0].name).toBe("bottle");
  });

  it("orders by prominence (area × confidence)", () => {
    const raw: RawDetection[] = [
      { bbox: [0, 0, 20, 20], className: "book", score: 0.9 },
      { bbox: [0, 0, 300, 300], className: "chair", score: 0.5 },
    ];
    const scene = buildScene(raw, 900, 600, "local", "test");
    expect(scene.objects[0].name).toBe("chair");
  });

  it("keeps positions in each object", () => {
    const scene = buildScene(
      [{ bbox: [700, 200, 80, 200], className: "phone", score: 0.8 }],
      900,
      600,
      "local",
      "test"
    );
    expect(scene.objects[0].position).toBe("right");
    expect(scene.backend).toBe("local");
  });
});