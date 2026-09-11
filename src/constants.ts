/**
 * WAYLO client constants. No secrets here — everything is publishable.
 * Secrets live in Supabase Secret Manager and are read only in Edge Functions.
 */

/** Runtime detection backend. "local" = TensorFlow.js COCO-SSD in the browser.
 *  "sima" = the honest, hardware-gated SiMa path (unavailable without hardware). */
export const VISION_BACKEND: "local" | "sima" = "local";

/** Minimum object confidence kept in a scene. */
export const MIN_OBJ_CONFIDENCE = 0.4;

/** Maximum objects kept per scene (prominence-ordered). */
export const MAX_DETECTIONS = 12;

/** Speechmatics RT token TTL requested from the Edge Function (seconds). Keep short. */
export const RT_TOKEN_TTL = 60;

/** Transcription language. */
export const STT_LANGUAGE = "en";

/** Silence gate: stop listening if no words for this long. */
export const STT_IDLE_TIMEOUT_MS = 9000;

/** Hard cap on a single utterance before forcing finalization (safety). */
export const STT_MAX_UTTERANCE_MS = 20_000;

/** Frames / second cap for the demo live-analysis loop. */
export const DEMO_ANALYSIS_FPS = 2;

/** COCO class → human-friendly label (kept as close to COCO as possible). */
export const COCO_LABELS: Record<string, string> = {
  "cell phone": "phone",
  "dining table": "table",
  couch: "sofa",
  "potted plant": "plant",
  "sports ball": "ball",
  "wine glass": "cup",
  "stop sign": "stop sign",
  "teddy bear": "teddy bear",
  "traffic light": "traffic light",
  tv: "television",
  laptop: "laptop",
  remote: "remote",
  keyboard: "keyboard",
  book: "book",
  cup: "cup",
  bottle: "bottle",
  chair: "chair",
  backpack: "backpack",
  umbrella: "umbrella",
  handbag: "handbag",
  suitcase: "suitcase",
  clock: "clock",
  vase: "vase",
  bed: "bed",
  sofa: "sofa",
};

/**
 * User words → canonical scene names. Lets "where's my mobile" match a "phone"
 * detection. Each canonical key MUST correspond to a label in COCO_LABELS or
 * a COCO class name; unmatched words just never match (honest miss).
 */
export const OBJECT_SYNONYMS: Record<string, string[]> = {
  phone: ["phone", "cell phone", "mobile", "smartphone", "iphone", "android", "cell"],
  table: ["table", "dining table", "desk", "coffee table"],
  sofa: ["sofa", "couch", "settee"],
  chair: ["chair", "seat", "stool"],
  bottle: ["bottle", "water bottle", "drink", "flask"],
  cup: ["cup", "mug", "glass", "tumbler", "wine glass"],
  book: ["book", "notebook", "magazine", "booklet"],
  laptop: ["laptop", "computer", "macbook", "notebook computer", "pc"],
  tv: ["television", "tv", "screen", "monitor", "display", "telly"],
  keyboard: ["keyboard", "key pad", "keys"],
  backpack: ["backpack", "bag", "rucksack", "knapsack"],
  umbrella: ["umbrella", "brolly"],
  person: ["person", "someone", "somebody", "man", "woman", "people", "guy", "child", "kid"],
  plant: ["plant", "potted plant", "flower", "pots"],
  bowl: ["bowl", "plate"],
  spoon: ["spoon", "fork", "knife", "cutlery", "utensil"],
  clock: ["clock", "watch", "time"],
  bed: ["bed", "mattress"],
  cat: ["cat", "kitten", "kitty"],
  dog: ["dog", "puppy", "pooch"],
  refrigerator: ["refrigerator", "fridge"],
  oven: ["oven", "stove"],
  sink: ["sink", "washbasin"],
  television: ["television", "tv"],
};

export const WAYLO_URL = "https://waylo.app"; // demo placeholder — not a real service