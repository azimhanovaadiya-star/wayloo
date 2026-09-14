/**
 * WAYLO Reasoning Engine — deterministic, local, testable.
 * Hard rule (PRD): never invent objects, positions, or text that are not in the
 * supplied scene. Every noun comes from Scene.objects; spatial claims ("below
 * the laptop", "in front of it") come only from the detected boxes — an object
 * lower in the frame that overlaps horizontally is "in front of" the one above it.
 * Natural-language goal: sound like a calm human assistant — group nearby
 * objects, say each direction once, stay concise for TTS. Accuracy > clarity >
 * natural language > vocabulary variety.
 */

import type { DetectedObject, Intent, Scene, WayloResponse, WayloTurn } from "../../types";
import { OBJECT_SYNONYMS } from "../../constants";

export interface QueryContext {
  /** Previous turns (capped ~2) for pronoun / "the same one" resolution. */
  history: WayloTurn[];
}

const READ_TEXT_RE =
  /(read (this|that|the|it)|read( the)? (text|sign|label|menu|writing|print)|what does (it|this|that|the (sign|label|text)) say|what('s| is) written|ocr)/i;
const SCENE_RE =
  /(what(?:’|')?s|what is) (in front|around|here|nearby|outside)|what do (you|i) see|what am i looking at|describe|scene|tell me about (the )?(room|scene|view|environment|surroundings)|is there anything (in front|around)|anything in (my|the) way|what'?s here/i;
/** "What's on my left?" — side-specific scene question. */
const SIDE_RE = /(?:on|to) (?:my|your) (?:left|right)(?: side)?/i;
const SPATIAL_RE = /(left|right|side|corner|which (side|way)|position of)/i;
const FIND_RE =
  /(where|find|look(ing)? for|do you (see|spot|have)|is there|is my|have you seen|locate|can you (see|find|spot)|find me)/i;
const OBSTACLE_RE =
  /(obstacle|block(ing|ed|s)?|in (my|the) way|clear path|walkable|bump into|stair|step|doorway)/i;
const IDENTIFY_RE =
  /(what('| i)?s (this|that)|identify (this|that)|what (am|are) (i|you) (holding|pointing at)|is this (a|an))/i;

/** "Is there a …?" / "Do you see a …?" — wants a direct yes/no, not a tour. */
const POLAR_RE =
  /^(is there|are (there|you|we)|do you (see|have|spot)|have you (got|seen)|can you (see|find|spot)|got (a|an|any)|is (a|an|this|that)|there(?:'s| is))/i;

function classifyIntent(query: string): Intent {
  const q = query.toLowerCase();
  if (READ_TEXT_RE.test(q)) return "READ_TEXT";
  if (SCENE_RE.test(q)) return "SCENE_DESCRIPTION";
  if (SIDE_RE.test(q)) return "SCENE_DESCRIPTION";
  if (SPATIAL_RE.test(q) && (FIND_RE.test(q) || SPATIAL_RE.test(q))) return "SPATIAL_QUERY";
  if (FIND_RE.test(q)) return "FIND_OBJECT";
  if (OBSTACLE_RE.test(q)) return "OBSTACLE_QUERY";
  if (IDENTIFY_RE.test(q)) return "IDENTIFY_OBJECT";
  return "GENERAL_VISUAL_QUERY";
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Pull the object phrase out of a find-style query ("where is my phone" → "phone"). */
export function extractTargetPhrase(query: string): string | null {
  const q = norm(query);
  const patterns = [
    /(?:where(?:'s| is)|where|find|look(?:ing)? for|do you see|can you (?:see|find|spot)|have you seen|find me|is there|is my)\s+(?:(?:the|a|an|my|your|our|his|her|their)\s+)?([a-z]{2,30}(?:\s+[a-z]{2,30}){0,3})(?=\s+(?:in|on|near|next|beside|behind|under|outside|inside|to|at|the|around)\b|$|\.)/i,
    /(?:which side (?:is|of|s)|on which side is)\s+(?:(?:the|a|an)\s+)?([a-z]{2,30})/i,
  ];
  for (const p of patterns) {
    const m = q.match(p);
    if (m?.[1] && m[1].trim().length >= 2) return m[1].trim();
  }
  return null;
}

/** Canonical COCO-ish name for a user word, via the synonym table. */
export function canonicalForWord(word: string): string | null {
  const w = norm(word);
  if (!w) return null;
  for (const [canonical, aliases] of Object.entries(OBJECT_SYNONYMS)) {
    if (canonical === w || aliases.includes(w)) return canonical;
  }
  return null;
}

/** Match a target phrase against the scene; returns matches (prominence-sorted). */
export function resolveObjects(phrase: string, scene: Scene): DetectedObject[] {
  const canonical = canonicalForWord(phrase);
  const words = norm(phrase).split(" ").filter((w) => w.length > 2);
  const matches = scene.objects.filter((obj) => {
    if (canonical && canonical === canonicalForWord(obj.name)) return true;
    return words.some((w) => canonicalForWord(w) === canonicalForWord(obj.name));
  });
  return [...matches].sort((a, b) => b.area - a.area);
}

/* ------------------------------------------------------------------------ *
 * Natural vocabulary — deterministic, chosen for the situation, never random.
 * ------------------------------------------------------------------------ */

type Position = DetectedObject["position"];

/** Where the group sits, phrased as a natural trailing clause. */
const POS_TAIL: Record<Position, string> = {
  center: "directly in front of you",
  left: "on your left",
  right: "on your right",
  // Lower in the frame = closer to the camera in a forward-facing view.
  below: "a bit lower down, close by",
  above: "up above you",
};

/** "slightly to your left/right" only when the box visibly hugs the middle. */
function posTailFor(o: DetectedObject, frameWidth: number): string {
  const cx = (o.bbox[0] + o.bbox[2]) / 2;
  const frac = frameWidth > 0 ? cx / frameWidth : 0;
  if (o.position === "left" && frac > 0.28 && frac < 0.42) return "slightly to your left";
  if (o.position === "right" && frac > 0.58 && frac < 0.72) return "slightly to your right";
  return POS_TAIL[o.position];
}

function countWord(n: number): string {
  if (n <= 1) return "a";
  if (n === 2) return "two";
  if (n === 3) return "three";
  if (n === 4) return "four";
  return `${n}`;
}

function plural(name: string, n: number): string {
  return n > 1 ? `${name}s` : name;
}

function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/* ------------------------------------------------------------------ *
 * Grouping — same-position objects are combined, direction said once.
 * ------------------------------------------------------------------ */

interface GroupEntry {
  name: string;
  count: number;
}

interface SceneGroup {
  position: Position;
  entries: GroupEntry[];
  raw: DetectedObject[];
}

/** Order groups the way a person would describe a view: ahead first. */
const GROUP_ORDER: Position[] = ["center", "left", "right", "below", "above"];

function groupByPosition(objs: DetectedObject[]): SceneGroup[] {
  const groups = new Map<Position, SceneGroup>();
  for (const o of objs) {
    const g = groups.get(o.position) ?? { position: o.position, entries: [], raw: [] };
    const entry = g.entries.find((e) => e.name === o.name);
    if (entry) entry.count += 1;
    else g.entries.push({ name: o.name, count: 1 });
    g.raw.push(o);
    groups.set(o.position, g);
  }
  return GROUP_ORDER.map((p) => groups.get(p)).filter((g) => g !== undefined) as SceneGroup[];
}

/** Largest box in a group — the "anchor" other objects relate to. */
function anchorOf(g: SceneGroup): DetectedObject {
  return [...g.raw].sort((a, b) => b.area - a.area)[0];
}

/**
 * Objects that sit lower in the frame AND overlap the anchor horizontally are
 * literally in front of it — a grounded "with a keyboard in front of it".
 */
function inFrontCluster(g: SceneGroup): { anchor: DetectedObject; frontal: DetectedObject[] } | null {
  if (g.position !== "center" || g.raw.length < 2) return null;
  const anchor = anchorOf(g);
  const [ax1, , ax2, ay2] = anchor.bbox;
  const frontal: DetectedObject[] = [];
  for (const o of g.raw) {
    if (o === anchor) continue;
    const [ox1, oy1, ox2] = o.bbox;
    const overlapX = Math.max(0, Math.min(ax2, ox2) - Math.max(ax1, ox1));
    const minW = Math.min(ax2 - ax1, ox2 - ox1);
    const lowerInFrame = oy1 >= ay2;
    const overlapping = overlapX >= 0.3 * minW;
    const smaller = o.area <= anchor.area * 0.95;
    if (lowerInFrame && overlapping && smaller) frontal.push(o);
  }
  return frontal.length > 0 ? { anchor, frontal } : null;
}

function entryText(e: GroupEntry): string {
  return `${countWord(e.count)} ${plural(e.name, e.count)}`;
}

/**
 * Plural verb only when the group is genuinely plural ("two mugs", "two mugs and
 * three books"). A mixed list like "a laptop and a keyboard" stays "There's…",
 * which is how a person actually speaks.
 */
function everyCounted(g: SceneGroup): boolean {
  return g.entries.length > 0 && g.entries.every((e) => e.count > 1);
}

function listEntries(entries: GroupEntry[]): string {
  return joinList(entries.map(entryText));
}

/**
 * One group → its clause. Only the first group carries the "There's…" verb.
 * `plain` drops the direction words entirely (used for "what's on my left?"
 * answers, where the side is already stated, so we never double it).
 */
function groupClause(g: SceneGroup, first: boolean, lowConf: boolean, plain: boolean, frameWidth: number): string {
  const cluster = inFrontCluster(g);
  if (cluster) {
    const frontEntries = new Map<string, number>();
    for (const f of cluster.frontal) frontEntries.set(f.name, (frontEntries.get(f.name) ?? 0) + 1);
    const frontalText = listEntries([...frontEntries].map(([name, count]) => ({ name, count })));
    const body = plain
      ? `a ${cluster.anchor.name}, with ${frontalText} in front of it`
      : `a ${cluster.anchor.name} ${POS_TAIL.center}, with ${frontalText} in front of it`;
    return first ? `${lowConf ? "It looks like there's" : "There's"} ${body}` : `and ${body}`;
  }
  const verb = lowConf ? (everyCounted(g) ? "It looks like there are" : "It looks like there's")
    : everyCounted(g) ? "There are" : "There's";
  const tail = plain ? "" : g.raw.length === 1 ? posTailFor(g.raw[0], frameWidth) : POS_TAIL[g.position];
  const list = listEntries(g.entries);
  const body = tail ? `${list} ${tail}` : list;
  return first ? `${verb} ${body}` : `and ${body}`;
}

/**
 * Compose the whole description from grouped, prominence-kept objects.
 * Groups read ahead-first; the same-position direction is named once per group.
 */
function describeScene(objs: DetectedObject[], plain = false): string {
  const groups = groupByPosition(objs);
  const frameWidth = Math.max(1, ...objs.map((o) => o.bbox[2]));
  return groups
    .map((g, i) => groupClause(g, i === 0, objs.every((o) => o.confidence < 0.55), plain, frameWidth))
    .join(", ");
}

/* ------------------------------------------------------------------ *
 * Spatial phrases — relative to the anchor, from boxes only.
 * ------------------------------------------------------------------ */

type SpatialRel = { other: DetectedObject; kind: "below" | "sameRow"; side?: "left" | "right" };

function locateRelation(target: DetectedObject, scene: Scene): SpatialRel | null {
  const [tx1, ty1, tx2, ty2] = target.bbox;
  const tW = tx2 - tx1;
  const tH = ty2 - ty1;
  const best: SpatialRel[] = [];
  for (const o of scene.objects) {
    if (o === target) continue;
    const [ox1, oy1, ox2, oy2] = o.bbox;
    const oW = ox2 - ox1;
    const oH = oy2 - oy1;
    const xOverlap = Math.max(0, Math.min(tx2, ox2) - Math.max(tx1, ox1));
    const yOverlap = Math.max(0, Math.min(ty2, oy2) - Math.max(ty1, oy1));
    // The other object ends above where this one starts → it sits behind/above.
    if (oy2 <= ty1 + 2 && xOverlap >= 0.3 * Math.min(tW, oW)) {
      best.push({ other: o, kind: "below" });
      break; // most informative relation — say "below X" and stop
    }
    if (yOverlap >= 0.3 * Math.min(tH, oH)) {
      const tc = (tx1 + tx2) / 2;
      const oc = (ox1 + ox2) / 2;
      const gap = Math.abs(tc - oc);
      // "just to the left/right of X" only when the two are genuinely adjacent,
      // not when the target is far away across the frame.
      if (gap >= 0.15 * Math.max(tW, oW) && gap <= 0.45 * frameWidth(scene)) {
        best.push({ other: o, kind: "sameRow", side: tc < oc ? "left" : "right" });
      }
    }
  }
  return best[0] ?? null;
}

/** Natural locating clause for a single object ("directly in front of you, below the laptop"). */
function spatialClause(target: DetectedObject, scene: Scene): { text: string; extra: DetectedObject[] } {
  const rel = locateRelation(target, scene);
  const tail = posTailFor(target, frameWidth(scene));
  if (rel && rel.kind === "below") return { text: `${tail}, below the ${rel.other.name}`, extra: [rel.other] };
  if (rel && rel.kind === "sameRow") return { text: `just to the ${rel.side} of the ${rel.other.name}`, extra: [rel.other] };
  return { text: tail, extra: [] };
}

function frameWidth(scene: Scene): number {
  return Math.max(1, ...scene.objects.map((o) => o.bbox[2]));
}

/* ------------------------------------------------------------------ */
/* Answers                                                             */
/* ------------------------------------------------------------------ */

function requestedSide(query: string): "left" | "right" | null {
  const m = query.toLowerCase().match(/(?:on|to) (?:my|your) (left|right)(?: side)?/);
  return m ? (m[1] as "left" | "right") : null;
}

function sceneDescription(query: string, scene: Scene): WayloResponse {
  if (scene.objects.length === 0) {
    return {
      intent: "SCENE_DESCRIPTION",
      text: "I can't make out any objects in the current view. Could you aim the camera at something, or step back a little?",
      referencedObjects: [],
      isMiss: false,
    };
  }
  const side = requestedSide(query);
  if (side) {
    const sideObjs = scene.objects.filter((o) => o.position === side);
    if (sideObjs.length === 0) {
      return {
        intent: "SCENE_DESCRIPTION",
        text: `I don't see anything on your ${side} right now.`,
        referencedObjects: [],
        isMiss: false,
      };
    }
    return {
      intent: "SCENE_DESCRIPTION",
      text: `On your ${side}, ${describeScene(sideObjs.slice(0, 5), true)}.`,
      referencedObjects: sideObjs.slice(0, 5),
      isMiss: false,
    };
  }
  const top = scene.objects.slice(0, 5);
  return {
    intent: "SCENE_DESCRIPTION",
    text: `${describeScene(top)}.`,
    referencedObjects: top,
    isMiss: false,
  };
}

function findObjectAnswer(query: string, phrase: string, scene: Scene): WayloResponse {
  const found = resolveObjects(phrase, scene);
  const target = found[0];
  const polar = POLAR_RE.test(query.trim()) && !/which (side|one|way)|where/i.test(query);
  if (!target) {
    return {
      intent: "FIND_OBJECT",
      text: polar
        ? `No — I can't see ${phrase} in the current view.`
        : `I can't see ${phrase} in the current view. It may be outside the frame or hidden behind something.`,
      referencedObjects: [],
      isMiss: true,
    };
  }
  const clause = spatialClause(target, scene);
  // The noun always comes from the scene ("bottle", never the user's "water bottle"),
  // so claims stay exactly as accurate as the detection.
  const text = polar ? `Yes, there's a ${target.name} ${clause.text}.` : `The ${target.name} is ${clause.text}.`;
  return {
    intent: "FIND_OBJECT",
    text,
    referencedObjects: [target, ...clause.extra],
    isMiss: false,
  };
}

function spatialAnswer(phrase: string, scene: Scene): WayloResponse {
  const target = resolveObjects(phrase, scene)[0];
  if (!target) {
    return {
      intent: "SPATIAL_QUERY",
      text: `I can't locate ${phrase} in the current view.`,
      referencedObjects: [],
      isMiss: true,
    };
  }
  const clause = spatialClause(target, scene);
  return {
    intent: "SPATIAL_QUERY",
    text: `The ${target.name} is ${clause.text}.`,
    referencedObjects: [target, ...clause.extra],
    isMiss: false,
  };
}

function identifyObject(scene: Scene): WayloResponse {
  if (scene.objects.length === 0) {
    return {
      intent: "IDENTIFY_OBJECT",
      text: "I don't see an object to identify in the current view. Point me at something and ask again.",
      referencedObjects: [],
      isMiss: true,
    };
  }
  const target = [...scene.objects].sort((a, b) => b.area - a.area)[0];
  const tail = POS_TAIL[target.position];
  const text =
    target.confidence < 0.62
      ? `That looks like a ${target.name}, ${tail}.`
      : `That's a ${target.name}, ${tail}.`;
  return { intent: "IDENTIFY_OBJECT", text, referencedObjects: [target], isMiss: false };
}

function obstacleAnswer(scene: Scene): WayloResponse {
  const obstacles = scene.objects.filter((o) => o.position === "below" || o.position === "center");
  const biggest = [...obstacles].sort((a, b) => b.area - a.area)[0];
  if (!biggest) {
    return {
      intent: "OBSTACLE_QUERY",
      text: "I don't see any obstacles directly in your path right now.",
      referencedObjects: [],
      isMiss: false,
    };
  }
  return {
    intent: "OBSTACLE_QUERY",
    text: `There's a ${biggest.name} close in front of you. Watch for it as you move.`,
    referencedObjects: [biggest],
    isMiss: false,
  };
}

function generalAnswer(scene: Scene): WayloResponse {
  if (scene.objects.length === 0) {
    return {
      intent: "GENERAL_VISUAL_QUERY",
      text: "The current view doesn't show anything I can name. Aim the camera at something and ask again.",
      referencedObjects: [],
      isMiss: false,
    };
  }
  const top = scene.objects.slice(0, 3);
  const sceneText = describeScene(top);
  return {
    intent: "GENERAL_VISUAL_QUERY",
    text: `Right now, ${sceneText.charAt(0).toLowerCase() + sceneText.slice(1)}. Ask me "where is" one of them and I'll point it out.`,
    referencedObjects: top,
    isMiss: false,
  };
}

/** Resolve pronouns / "the same one" against recent turns. */
function resolveReference(query: string, ctx: QueryContext): string {
  if (!/(it|that one|this one|the same|those|them|him|her|el|del)\b/.test(query.toLowerCase())) return query;
  for (let i = ctx.history.length - 1; i >= 0; i--) {
    const referenced = ctx.history[i].response.referencedObjects[0];
    if (referenced) return referenced.name;
  }
  return query;
}

/** Main entry: synthesize the answer strictly from the scene + intent. */
export function synthesizeResponse(
  query: string,
  scene: Scene,
  ctx: QueryContext = { history: [] }
): WayloResponse {
  const resolved = resolveReference(query, ctx);
  const intent = classifyIntent(resolved);

  // READ_TEXT is honestly deferred (phase 2) — never faked.
  if (intent === "READ_TEXT") {
    return {
      intent,
      text: "Reading text isn't available in this version yet. Ask me what objects you can see, or where something is.",
      referencedObjects: [],
      isMiss: false,
    };
  }
  if (intent === "SCENE_DESCRIPTION") return sceneDescription(resolved, scene);
  if (intent === "FIND_OBJECT") return findObjectAnswer(resolved, extractTargetPhrase(resolved) ?? resolved, scene);
  if (intent === "SPATIAL_QUERY") return spatialAnswer(extractTargetPhrase(resolved) ?? resolved, scene);
  if (intent === "OBSTACLE_QUERY") return obstacleAnswer(scene);
  if (intent === "IDENTIFY_OBJECT") return identifyObject(scene);
  return generalAnswer(scene);
}

export { classifyIntent };