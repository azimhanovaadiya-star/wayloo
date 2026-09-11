/**
 * Focused tests for the Speechmatics v2 message parsing path that feeds the
 * `onPartial`/`onFinal` callbacks. Uses the real server message shapes
 * (word-level `results[].alternatives[].content` and aggregated
 * `metadata.transcript`) — nothing here is mocked or fabricated.
 */
import { describe, expect, it } from "vitest";
import { transcriptOf } from "./SpeechService";

describe("transcriptOf (Speechmatics v2 wire format)", () => {
  it("extracts a partial transcript from word-level results", () => {
    const msg = {
      message: "AddPartialTranscript",
      metadata: { transaction_id: "abc", end_time: 1.24 },
      results: [
        {
          type: "word",
          alternatives: [{ confidence: 0.99, content: "hello", language: "en" }],
          start_time: 0.9,
          end_time: 1.1,
        },
        {
          type: "word",
          alternatives: [{ confidence: 0.97, content: "world", language: "en" }],
          start_time: 1.1,
          end_time: 1.24,
        },
      ],
    };
    expect(transcriptOf(msg)).toBe("hello world");
  });

  it("extracts a final transcript from word-level results", () => {
    const msg = {
      message: "AddTranscript",
      metadata: { transaction_id: "abc" },
      results: [
        {
          type: "word",
          alternatives: [{ confidence: 1.0, content: "Open", language: "en" }],
          start_time: 0.0,
          end_time: 0.4,
        },
        {
          type: "word",
          alternatives: [{ confidence: 1.0, content: "the", language: "en" }],
          start_time: 0.4,
          end_time: 0.55,
        },
        {
          type: "word",
          alternatives: [{ confidence: 1.0, content: "door", language: "en" }],
          start_time: 0.55,
          end_time: 0.8,
        },
      ],
    };
    expect(transcriptOf(msg)).toBe("Open the door");
  });

  it("prefers the aggregated metadata.transcript when the server sends it", () => {
    const msg = {
      message: "AddTranscript",
      metadata: { transcript: "Turn left at the corner" },
      results: [
        { type: "word", alternatives: [{ content: "Turn" }] },
        { type: "word", alternatives: [{ content: "left" }] },
      ],
    };
    expect(transcriptOf(msg)).toBe("Turn left at the corner");
  });

  it("returns an empty string for messages that carry no transcript", () => {
    expect(transcriptOf({ message: "RecognitionStarted" })).toBe("");
    expect(transcriptOf({ message: "EndOfTranscript", metadata: { transaction_id: "x" } })).toBe("");
    expect(transcriptOf({ message: "AddTranscript", results: [] })).toBe("");
  });

  it("does not crash on malformed payloads", () => {
    expect(transcriptOf({ message: "AddPartialTranscript", results: "nope" })).toBe("");
    expect(transcriptOf({ message: "AddTranscript", metadata: null })).toBe("");
    expect(transcriptOf({})).toBe("");
  });
});