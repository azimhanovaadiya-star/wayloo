/**
 * WAYLO shared contracts.
 * Everything the UI, engines, and reasoning exchange is typed here.
 */

/** Relative position of a detected object, derived from box centroid vs frame thirds. */
export type RelativePosition = "left" | "center" | "right" | "above" | "below";

/** A single object as it exists in the structured scene (never raw pixels). */
export interface DetectedObject {
  /** Canonical class name (COCO vocabulary, human-friendly). */
  name: string;
  /** Model confidence 0..1. */
  confidence: number;
  /** Normalized box as [x1, y1, x2, y2] in video pixels. */
  bbox: [number, number, number, number];
  /** Where in the frame the object sits. */
  position: RelativePosition;
  /** Box area in px² — used as prominence proxy. */
  area: number;
}

/** The structured scene — the single source of truth fed to reasoning. */
export interface Scene {
  timestamp: string;
  objects: DetectedObject[];
  /** Which engine produced it ("local" | "sima") — shown honestly in demo mode. */
  backend: VisionBackendId;
  /** Human label of the model, e.g. "COCO-SSD (TensorFlow.js)". */
  modelLabel: string;
}

export type VisionBackendId = "local" | "sima";

/** Output of one frame analysis, before scene assembly. */
export interface RawDetection {
  bbox: [number, number, number, number];
  className: string;
  score: number;
}

/** The engine seam — every vision engine implements this. */
export interface VisionEngine {
  readonly id: VisionBackendId;
  readonly modelLabel: string;
  /** Load the model. Called once, lazily. */
  load(): Promise<void>;
  /** Run inference on the live video element and return raw detections. */
  analyse(video: HTMLVideoElement): Promise<RawDetection[]>;
  /** True once the model is loaded and inference is possible. */
  readonly isLoaded: boolean;
}

export type Intent =
  | "SCENE_DESCRIPTION"
  | "FIND_OBJECT"
  | "IDENTIFY_OBJECT"
  | "READ_TEXT"
  | "SPATIAL_QUERY"
  | "OBSTACLE_QUERY"
  | "GENERAL_VISUAL_QUERY";

/** A synthesized, honest answer — never anything not present in the scene. */
export interface WayloResponse {
  intent: Intent;
  /** The sentence(s) to speak and show. */
  text: string;
  /** Objects actually referenced from the scene (for the debug panel). */
  referencedObjects: DetectedObject[];
  /** True when the user asked about an object that the scene does not contain. */
  isMiss: boolean;
}

/** Voice-loop state machine per the PRD. */
export type WayloState = "idle" | "listening" | "analyzing" | "responding";

export interface WayloTurn {
  query: string;
  response: WayloResponse;
  scene: Scene | null;
  metrics: LatencyMetrics;
  at: string;
}

/** Real measured latencies (ms). null = that leg was not measured (N/A). */
export interface LatencyMetrics {
  tokenMs: number | null;
  sttMs: number | null;
  visionMs: number | null;
  reasoningMs: number | null;
  ttsBeginMs: number | null;
}

/** What slowed/failed — never fabricated. */
export type EngineFailureKind =
  | "camera"
  | "microphone"
  | "stt"
  | "vision"
  | "tts"
  | "general";

export interface WayloError {
  kind: EngineFailureKind;
  /** Human, voiceable message. */
  message: string;
  /** Stable key so calls to speak it can be deduped. */
  id: number;
}

/** Speech service events (all Speechmatics knowledge stays in SpeechService). */
export type SpeechEvent =
  | { type: "partial"; text: string }
  | { type: "final"; text: string; durationMs: number }
  | { type: "started" }
  | { type: "ended" }
  | { type: "error"; message: string };