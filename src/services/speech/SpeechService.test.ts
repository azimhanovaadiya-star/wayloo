/**
 * Focused tests for the Speechmatics v2 message parsing path that feeds the
 * `onPartial`/`onFinal` callbacks, plus the mic-vs-recognition error model and
 * the browser Web Speech fallback engine. Parsing tests use the real server
 * message shapes (word-level `results[].alternatives[].content` and aggregated
 * `metadata.transcript`) — nothing is mocked or fabricated except the browser
 * APIs (getUserMedia / SpeechRecognition) that cannot exist in Node.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SpeechError,
  SpeechService,
  browserSpeechSupported,
  micFailureKind,
  transcriptOf,
} from "./SpeechService";

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

/** getUserMedia failure names must classify into permission vs availability —
 *  a missing mic is NOT "denied", and a denial must never be hidden as generic. */
describe("micFailureKind (mic error classification)", () => {
  it("maps permission failures to 'permission'", () => {
    expect(micFailureKind("NotAllowedError")).toBe("permission");
    expect(micFailureKind("SecurityError")).toBe("permission");
  });

  it("maps device/availability failures to 'unavailable'", () => {
    expect(micFailureKind("NotFoundError")).toBe("unavailable");
    expect(micFailureKind("NotReadableError")).toBe("unavailable");
    expect(micFailureKind("NotSupportedError")).toBe("unavailable");
    expect(micFailureKind("OverconstrainedError")).toBe("unavailable");
  });

  it("maps everything else to 'stt' (never 'permission')", () => {
    expect(micFailureKind("NetworkError")).toBe("stt");
    expect(micFailureKind("")).toBe("stt");
    expect(micFailureKind("UnknownError")).toBe("stt");
  });

  it("SpeechError preserves the underlying name for exact UI recovery steps", () => {
    const err = new SpeechError("permission", "denied", "NotAllowedError");
    expect(err.name).toBe("NotAllowedError");
    expect(err.kind).toBe("permission");
    expect(err.message).toContain("denied");
  });
});

describe("microphone permission (explicit pre-STT request)", () => {
  function fakeStream() {
    const tracks = [{ readyState: "live", stop: vi.fn() }, { readyState: "live", stop: vi.fn() }];
    return {
      tracks,
      getAudioTracks: () => tracks.filter((t) => t.readyState === "live"),
      getTracks: () => tracks,
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    svc.releasePermission();
  });

  const svc = new SpeechService();

  it("calls getUserMedia({ audio }) exactly once and holds the granted stream", async () => {
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream());
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await svc.requestPermission();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0][0]).toEqual({ audio: expect.anything() });
    expect(svc.micPermissionHeld).toBe(true);

    // Second request reuses the held stream — no second browser dialog.
    await svc.requestPermission();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("releasePermission stops the held tracks", async () => {
    const stream = fakeStream();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });

    await svc.requestPermission();
    expect(svc.micPermissionHeld).toBe(true);

    svc.releasePermission();
    expect(stream.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    expect(svc.micPermissionHeld).toBe(false);
  });

  it("rejects with the DOMException name preserved so the UI can show recovery steps", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(denied) } });

    await expect(svc.requestPermission()).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(svc.micPermissionHeld).toBe(false);
  });
});

describe("browser Web Speech fallback engine", () => {
  /** Minimal stand-in for window.SpeechRecognition. */
  class FakeRecognition {
    static last: FakeRecognition | null = null;
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    onstart: (() => void) | null = null;
    onresult: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    started = false;
    aborted = false;
    start() {
      this.started = true;
      FakeRecognition.last = this;
      this.onstart?.();
    }
    stop() {
      /* noop */
    }
    abort() {
      this.aborted = true;
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeRecognition.last = null;
  });

  it("is reported as unsupported when no browser globals exist (Node)", () => {
    expect(browserSpeechSupported()).toBe(false);
  });

  it("falls back to the Web Speech API when Speechmatics cannot start, and pushes transcripts", async () => {
    // No VITE_SUPABASE_URL in the test env → the Speechmatics token fetch fails
    // before any mic prompt → the service must fall back, not fail silently.
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });

    const svc = new SpeechService();
    const events: Array<{ type: string; text?: string }> = [];
    const finals: Array<[string, number]> = [];
    await svc.start({
      onEvent: (e) => events.push(e),
      onFinal: (text, ms) => finals.push([text, ms]),
    });

    expect(events.some((e) => e.type === "started")).toBe(true);
    const rec = FakeRecognition.last;
    expect(rec).not.toBeNull();

    // Interim partial first…
    rec!.onresult!({
      resultIndex: 0,
      results: [{ 0: { transcript: "what is" }, isFinal: false }],
    });
    expect(events.some((e) => e.type === "partial" && e.text === "what is")).toBe(true);
    expect(finals).toHaveLength(0);

    // …then the finalized result → onFinal, then the service stops itself.
    rec!.onresult!({
      resultIndex: 1,
      results: [{ 0: { transcript: "what is in front of me" }, isFinal: true }],
    });
    expect(finals.map(([t]) => t)).toEqual(["what is in front of me"]);
    expect(svc.active).toBe(false);

    await svc.stop(); // idempotent
  });

  it("surfaces a mic-denied error from the fallback engine with the right name", async () => {
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });

    const svc = new SpeechService();
    const events: Array<{ type: string; name?: string; message?: string }> = [];
    const started = svc.start({ onEvent: (e) => events.push(e), onFinal: () => undefined });

    // Simulate the permission prompt being refused mid-start (after onstart).
    await started;
    FakeRecognition.last?.onerror?.({ error: "not-allowed" });
    expect(events.some((e) => e.type === "error" && e.name === "NotAllowedError")).toBe(true);
  });
});