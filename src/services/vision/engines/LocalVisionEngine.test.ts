/**
 * Regression test for the "No backend found in registry" failure: tfjs-core
 * throws it the moment the model runs an op unless a compute backend has been
 * registered (the @tensorflow/tfjs union import + ensureBackend()).
 */
import { describe, expect, it } from "vitest";
import { ensureBackend } from "./LocalVisionEngine";

describe("LocalVisionEngine compute backend", () => {
  it("activates a registered backend (webgl or cpu) so model ops never hit 'No backend found in registry'", async () => {
    const backend = await ensureBackend();
    expect(["webgl", "cpu"]).toContain(backend);
  });
});
