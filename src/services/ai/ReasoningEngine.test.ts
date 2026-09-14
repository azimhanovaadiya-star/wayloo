/**
 * Unit tests for the Reasoning Engine (PRD §Testing): intent classification,
 * find-object (incl. honest miss), context resolution, and the no-hallucination
 * hard rule.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalForWord,
  classifyIntent,
  extractTargetPhrase,
  resolveObjects,
  synthesizeResponse,
} from "./ReasoningEngine";
import type { DetectedObject, Scene, WayloTurn } from "../../types";

function sceneWith(objects: Array<[string, number, number]>): Scene {
  return {
    timestamp: new Date().toISOString(),
    objects: objects.map(([name, cx, area]) => ({
      name,
      confidence: 0.9,
      bbox: [cx, 100, cx + 100, 300],
      position: cx < 300 ? "left" : cx > 600 ? "right" : "center",
      area,
    })),
    backend: "local",
    modelLabel: "test",
  };
}

describe("classifyIntent", () => {
  it("detects a scene description", () => {
    expect(classifyIntent("What's in front of me?")).toBe("SCENE_DESCRIPTION");
    expect(classifyIntent("Describe what you see")).toBe("SCENE_DESCRIPTION");
    expect(classifyIntent("what is around here")).toBe("SCENE_DESCRIPTION");
  });
  it("detects find-object", () => {
    expect(classifyIntent("Where is my phone?")).toBe("FIND_OBJECT");
    expect(classifyIntent("find the bottle")).toBe("FIND_OBJECT");
    expect(classifyIntent("Do you see a chair?")).toBe("FIND_OBJECT");
  });
  it("detects spatial queries", () => {
    expect(classifyIntent("Which side is the table on?")).toBe("SPATIAL_QUERY");
  });
  it("detects obstacle queries", () => {
    expect(classifyIntent("Is anything blocking my way?")).toBe("OBSTACLE_QUERY");
    expect(classifyIntent("is there anything in my way")).toBe("SCENE_DESCRIPTION");
  });
  it("detects identify", () => {
    expect(classifyIntent("What is this in front of me?")).toBe("IDENTIFY_OBJECT");
  });
  it("detects read-text (deferred)", () => {
    expect(classifyIntent("Can you read this sign?")).toBe("READ_TEXT");
  });
});

describe("extractTargetPhrase", () => {
  it("pulls the noun out of a where-question", () => {
    expect(extractTargetPhrase("Where is my phone?")).toBe("phone");
    expect(extractTargetPhrase("find the water bottle")).toBe("water bottle");
  });
  it("returns null when there is no noun", () => {
    expect(extractTargetPhrase("What's in front of me?")).toBeNull();
  });
});

describe("canonicalForWord + resolveObjects", () => {
  it("resolves synonyms to the same canonical name", () => {
    expect(canonicalForWord("mobile")).toBe("phone");
    expect(canonicalForWord("phone")).toBe("phone");
  });
  it("matches scene objects via synonyms", () => {
    const scene = sceneWith([["phone", 200, 4000]]);
    expect(resolveObjects("where is my mobile", scene)).toHaveLength(1);
    expect(resolveObjects("my cell phone", scene)).toHaveLength(1);
  });
});

describe("honesty rules — never invent objects", () => {
  it("find-object miss is honest and says no location", () => {
    const scene = sceneWith([["table", 450, 5000]]);
    const r = synthesizeResponse("Where is my phone?", scene);
    expect(r.isMiss).toBe(true);
    expect(r.text).toContain("can't see");
    expect(r.text.toLowerCase()).not.toContain("left");
    expect(r.text.toLowerCase()).not.toContain("right");
  });
  it("answers only with objects actually in the scene", () => {
    const scene = sceneWith([
      ["table", 300, 5000],
      ["chair", 700, 4000],
    ]);
    const r = synthesizeResponse("What's in front of me?", scene);
    expect(r.text.toLowerCase()).toContain("table");
    expect(r.text.toLowerCase()).toContain("chair");
    expect(r.text.toLowerCase()).not.toContain("phone");
    expect(r.text.toLowerCase()).not.toContain("person");
  });
  it("empty scene → cautious phrasing, no fabrication", () => {
    const r = synthesizeResponse("Describe what you see", sceneWith([]));
    expect(r.text.toLowerCase()).toContain("can't");
  });
});

describe("find-object happy path", () => {
  it("tells the direction of a found object", () => {
    const scene = sceneWith([
      ["phone", 100, 300],
      ["table", 500, 5000],
    ]);
    const r = synthesizeResponse("Where is my phone?", scene);
    expect(r.isMiss).toBe(false);
    expect(r.text.toLowerCase()).toContain("phone");
    expect(r.text.toLowerCase()).toContain("left");
  });
});

describe("context — follow-up questions", () => {
  it("resolves 'it' to the previous turn's object", () => {
    const scene = sceneWith([
      ["bottle", 700, 300],
      ["table", 500, 5000],
    ]);
    const prior: WayloTurn = {
      query: "Where is my bottle?",
      response: synthesizeResponse("Where is my bottle?", scene),
      scene,
      metrics: { tokenMs: null, sttMs: null, visionMs: 10, reasoningMs: 10, ttsBeginMs: null },
      at: new Date().toISOString(),
    };
    const r = synthesizeResponse("Where is it, exactly?", scene, { history: [prior] });
    expect(r.text.toLowerCase()).toContain("bottle");
    expect(r.isMiss).toBe(false);
  });
});

describe("read-text is honestly deferred", () => {
  it("does not pretend to OCR", () => {
    const r = synthesizeResponse("Read the sign for me", sceneWith([]));
    expect(r.text.toLowerCase()).toContain("isn't available");
  });
});

describe("natural, non-repetitive scene descriptions", () => {
  it("combines same-position objects and says the direction once", () => {
    const scene = sceneWith([
      ["laptop", 450, 9000],
      ["keyboard", 480, 5000],
    ]);
    const r = synthesizeResponse("What's in front of me?", scene);
    expect(r.text).toBe("There's a laptop and a keyboard directly in front of you.");
    expect(r.text.match(/in front of you/g)).toHaveLength(1);
  });
  it("never repeats 'straight ahead of you' per object", () => {
    const scene = sceneWith([
      ["laptop", 440, 9000],
      ["keyboard", 470, 5000],
      ["mouse", 460, 2000],
    ]);
    const r = synthesizeResponse("Describe what you see", scene);
    expect(r.text.match(/straight ahead of you/g) ?? []).toHaveLength(0);
    expect(r.text.match(/directly in front of you/g)).toHaveLength(1);
  });
  it("names each direction once across groups", () => {
    const scene = sceneWith([
      ["table", 450, 5000],
      ["chair", 700, 4000],
    ]);
    const r = synthesizeResponse("What's in front of me?", scene);
    expect(r.text).toBe("There's a table directly in front of you, and a chair on your right.");
  });
  it("answers a side-specific question with only that side", () => {
    const scene = sceneWith([
      ["mug", 200, 3000],
      ["phone", 700, 2500],
    ]);
    const r = synthesizeResponse("What is on my left?", scene);
    expect(r.text).toContain("mug");
    expect(r.text).toContain("left");
    expect(r.text).not.toContain("phone");
    expect(r.text).not.toContain("right");
  });
  it("is candid when the requested side is empty", () => {
    const scene = sceneWith([["phone", 700, 2500]]);
    const r = synthesizeResponse("What is on my left?", scene);
    expect(r.text).toBe("I don't see anything on your left right now.");
  });
  it("never invents adjectives or materials", () => {
    const scene = sceneWith([["laptop", 450, 9000]]);
    const r = synthesizeResponse("What's in front of me?", scene);
    expect(r.text.toLowerCase()).toMatch(/^(?!.*(silver|wooden|desk|leather|black|sitting)).*/);
    expect(r.text).toBe("There's a laptop directly in front of you.");
  });
});

describe("polar yes/no answers", () => {
  it("answers 'is there a laptop?' directly", () => {
    const scene = sceneWith([["laptop", 450, 9000]]);
    const r = synthesizeResponse("Is there a laptop?", scene);
    expect(r.text.startsWith("Yes")).toBe(true);
    expect(r.text).toContain("laptop");
    expect(r.text).toContain("in front of you");
  });
  it("says no without a tour when the object is absent", () => {
    const scene = sceneWith([["table", 450, 5000]]);
    const r = synthesizeResponse("Is there a laptop?", scene);
    expect(r.isMiss).toBe(true);
    expect(r.text.toLowerCase()).toContain("can't");
  });
});

describe("grounded relative positions", () => {
  it("says 'below the laptop' when the box is genuinely lower and overlapping", () => {
    const scene: Scene = {
      timestamp: new Date().toISOString(),
      objects: [
        { name: "laptop", confidence: 0.92, bbox: [300, 100, 500, 300], position: "center", area: 40000 },
        { name: "keyboard", confidence: 0.88, bbox: [320, 320, 480, 420], position: "center", area: 16000 },
      ],
      backend: "local",
      modelLabel: "test",
    };
    const r = synthesizeResponse("Where is the keyboard?", scene);
    expect(r.text).toBe("The keyboard is directly in front of you, below the laptop.");
    expect(r.referencedObjects.map((o: DetectedObject) => o.name)).toContain("laptop");
  });
  it("does not claim a below-relation without horizontal overlap", () => {
    const scene: Scene = {
      timestamp: new Date().toISOString(),
      objects: [
        { name: "laptop", confidence: 0.92, bbox: [100, 100, 300, 300], position: "left", area: 40000 },
        { name: "keyboard", confidence: 0.88, bbox: [500, 320, 700, 420], position: "right", area: 16000 },
      ],
      backend: "local",
      modelLabel: "test",
    };
    const r = synthesizeResponse("Where is the keyboard?", scene);
    expect(r.text.toLowerCase()).not.toContain("below the laptop");
    expect(r.text).toContain("right");
  });
});