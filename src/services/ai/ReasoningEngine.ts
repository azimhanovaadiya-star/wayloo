/**
 * WAYLO Reasoning Engine — deterministic, local, testable.
 * Hard rule (PRD): never invent objects, positions, or text that are not in the
 * supplied scene. Every noun comes from Scene.objects; spatial claims ("below
 * the laptop", "in front of it") come only from the detected boxes — an object
 * lower in the frame that overlaps horizontally is "in front of" the one above it.
 * Natural-language goal: sound like a calm human assistant — group nearby
 * objects, say each direction once, stay concise for TTS. Accuracy > clarity >
 * natural language > vocabulary variety.
 *
 * Spatial model (voice-first): a detected object is located BOTH by a direction
 * (left / right / directly ahead / near the top or bottom) AND by a clock
 * position derived from its box centroid against the frame:
 *   12 o'clock = directly ahead · 10–11 = front-left · 1–2 = front-right
 *   9 = left · 3 = right — "around X" whenever the box doesn't support an
 *   exact hour, plus a vertical hint when the object sits high or low.
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
  /(what(?:’|')?s|what is) (in front|around|here|nearby|outside)|what do (you|i) see|what am i looking at|describe|scene|tell me about (the )?(room|scene|view|environment|surroundings)|is there anything (in front|around|above|below)|anything in (my|the) way|what'?s here/i;
/** "What's on my left?" — side-specific scene question. */
const SIDE_RE = /(?:on|to) (?:my|your) (?:left|right)(?: side)?/i;
/** "What's above me?" / "What's below me?" — vertical-zone scene question. */
const VERT_RE = /(?:what(?:'s| is)|anything) (?:above|below|under|over) (?:me|us|my (?:head|feet))|(?:above|below) me/i;
const SPATIAL_RE = /(left|right|side|corner|which (side|way)|position of)/i;
const FIND_RE =
  /(where|find|look(?:ing)? for|do you (see|spot|have)|is there|is my|have you seen|locate|can you (see|find|spot)|find me)/i;
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
  if (VERT_RE.test(q)) return "SCENE_DESCRIPTION";
  if (SIDE_RE.test(q)) return "SCENE_DESCRIPTION";
  if (SCENE_RE.test(q)) return "SCENE_DESCRIPTION";
  if (SPATIAL_RE.test(q)) return "SPATIAL_QUERY";
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
    /(?:where(?:'s| is)|where|find|look(?:ing)? for|do you see|can you (?:see|find|spot)|have you seen|find me|is there|is my)\s+(?:(?:the|a|an|my|your|our|his|her|their|any)\s+)?([a-z]{2,30}(?:\s+[a-z]{2,30}){0,4})(?=\s+(?:in|on|near|next|beside|behind|under|outside|inside|to|at|the|around)\b|$|\.|\?)/i,
    /(?:which side (?:is|of)|on which side is)\s+(?:(?:the|a|an)\s+)?([a-z]{2,30})/i,
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

/** Match a target phrase against the scene; returns ALL matches (prominence-sorted). */
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
 * Spatial vocabulary — direction + clock + vertical depth + relationship.
 * ------------------------------------------------------------------------ */

type Position = DetectedObject["position"];

/** Frame dimensions — real when present, otherwise inferred from boxes. */
function frameSize(scene: Scene): { w: number; h: number } {
  const w = scene.frameWidth > 0 ? scene.frameWidth : Math.max(1, ...scene.objects.map((o) => o.bbox[2]));
  const h = scene.frameHeight > 0 ? scene.frameHeight : Math.max(1, ...scene.objects.map((o) => o.bbox[3]));
  return { w, h };
}

function centroid(o: DetectedObject): { fx: number; fy: number } {
  const [x1, y1, x2, y2] = o.bbox;
  return { fx: (x1 + x2) / 2, fy: (y1 + y2) / 2 };
}

/**
 * Clock hour of an object's horizontal centroid — a linear map of frame width
 * onto the clock face around the user: far-left → 9, centre → 12, far-right → 15 (3).
 */
function clockHour(o: DetectedObject, frameW: number): number {
  const { fx } = centroid(o);
  const cx = frameW > 0 ? Math.min(1, Math.max(0, fx / frameW)) : 0.5;
  return 9 + 6 * cx;
}

/** Human clock phrase from the hour number ("around 10 o'clock", "around 2 to 3 o'clock"). */
function clockPhrase(hour: number): string {
  if (hour < 9.7) return "around 9 o'clock";
  if (hour < 10.5) return "around 10 o'clock";
  if (hour < 11.5) return "around 10 to 11 o'clock";
  if (hour <= 12.5) return "around 12 o'clock";
  if (hour < 13.5) return "around 1 to 2 o'clock";
  if (hour < 14.5) return "around 2 to 3 o'clock";
  return "around 3 o'clock";
}

/**
 * Direction word, derived from the detected POSITION band (which the vision
 * layer computes frame-relative and stays correct even when real frame
 * dimensions are missing), with a subtle inboard nuance for boxes that hug the
 * inner edge of their side. The clock phrase below stays frame-derived and is
 * purely auxiliary — never the source of a left/right claim.
 */
function directionForPosition(o: DetectedObject, frameW: number): string {
  switch (o.position) {
    case "center":
      return "directly ahead";
    case "left": {
      const cx = cxOf(o, frameW);
      return cx > 0.28 && cx < 0.42 ? "slightly to your left" : "on your left";
    }
    case "right": {
      const cx = cxOf(o, frameW);
      return cx > 0.58 && cx < 0.72 ? "slightly to your right" : "on your right";
    }
    case "below":
      return "down closer to you";
    case "above":
      return "up above you";
  }
}

type Loc = { phrase: string; extra: DetectedObject[] };

/** Full spatial clause for one object: direction + clock + vertical depth + relation. */
function locateObject(target: DetectedObject, scene: Scene): Loc {
  const { w, h } = frameSize(scene);
  const { fy } = centroid(target);
  const cy = h > 0 ? fy / h : 0.5;

  const direction = directionForPosition(target.position, w);
  // Clock: meaningful for left/right (9↔3); for top/bottom the vertical band
  // already says it, for center "directly ahead" carries the meaning.
  const clock =
    target.position === "left" || target.position === "right"
      ? `, ${clockPhrase(clockHour(target, w))}`
      : target.position === "below"
        ? ", down near the ground"
        : target.position === "above"
          ? ", up above"
          : "";
  const depth = cy < 0.28 ? " near the top of your view" : cy > 0.72 ? " near the bottom of your view" : "";

  const rel = locateRelation(target, scene);
  let relation = "";
  let extra: DetectedObject[] = [];
  if (rel) {
    relation =
      rel.kind === "below"
        ? `, below the ${rel.other.name}`
        : `, ${rel.side === "left" ? "to the left of" : "to the right of"} the ${rel.other.name}`;
    extra = [rel.other];
  }

  return {
    phrase: `${direction}${clock}${depth}${relation}`,
    extra,
  };
}

/** The anchor pair for the fallback cx used only when bboxes are degenerate. */
function cxOf(o: DetectedObject, w: number): number {
  const { fx } = centroid(o);
  return w > 0 ? Math.min(1, Math.max(0, fx / w)) : 0.5;
}

/* ------------------------------------------------------------------ *
 * Relationship detection — an object lower + overlapping = in front.
 * ------------------------------------------------------------------ */

type SpatialRel = { other: DetectedObject; kind: "below" | "sameRow"; side?: "left" | "right" };

function locateRelation(target: DetectedObject, scene: Scene): SpatialRel | null {
  const [tx1, ty1, tx2, ty2] = target.bbox;
  const tW = tx2 - tx1;
  const tH = ty2 - ty1;
  const frameW = frameSize(scene).w;
  let best: SpatialRel | null = null;
  let bestScore = 0;

  for (const o of scene.objects) {
    if (o === target) continue;
    const [ox1, oy1, ox2, oy2] = o.bbox;
    const oW = ox2 - ox1;
    const oH = oy2 - oy1;
    const xOverlap = Math.max(0, Math.min(tx2, ox2) - Math.max(tx1, ox1));
    const yOverlap = Math.max(0, Math.min(ty2, oy2) - Math.max(ty1, oy1));
    // The other object ends above where this one starts → it sits behind/above.
    if (oy2 <= ty1 + 2 && xOverlap >= 0.3 * Math.min(tW, oW)) {
      const score = xOverlap / (Math.max(tW, oW) + 1);
      if (score > bestScore) {
        best = { other: o, kind: "below" };
        bestScore = score;
      }
      continue;
    }
    // Row-sibling: same vertical band, genuinely adjacent horizontally.
    if (yOverlap >= 0.3 * Math.min(tH, oH)) {
      const tc = (tx1 + tx2) / 2;
      const oc = (ox1 + ox2) / 2;
      const gap = Math.abs(tc - oc);
      if (gap >= 0.15 * Math.max(tW, oW) && gap <= 0.45 * frameW) {
        const score = yOverlap / (Math.max(tH, oH) + 1);
        if (score > bestScore) {
          best = { other: o, kind: "sameRow", side: tc < oc ? "left" : "right" };
          bestScore = score;
        }
      }
    }
  }
  return bestScore > 0 ? best : null;
}

/* ------------------------------------------------------------------ *
 * Grouping — same-position objects combine; direction said once.
 * ------------------------------------------------------------------ */

interface SceneGroup {
  position: Position;
  objs: DetectedObject[];
  names: Array<{ name: string; count: number }>;
}

/** Order groups the way a person scans a room: LEFT → CENTER → RIGHT → vertical extras. */
const GROUP_ORDER: Position[] = ["left", "center", "right", "below", "above"];

function groupByPosition(objs: DetectedObject[]): SceneGroup[] {
  const groups = new Map<Position, SceneGroup>();
  for (const o of objs) {
    const g = groups.get(o.position) ?? { position: o.position, objs: [], names: [] };
    const entry = g.names.find((e) => e.name === o.name);
    if (entry) entry.count += 1;
    else g.names.push({ name: o.name, count: 1 });
    g.objs.push(o);
    groups.set(o.position, g);
  }
  return GROUP_ORDER.map((p) => groups.get(p)).filter((g) => g !== undefined) as SceneGroup[];
}

function anchorOf(g: SceneGroup): DetectedObject {
  return [...g.objs].sort((a, b) => b.area - a.area)[0];
}

/** Objects lower in the frame AND overlapping the anchor horizontally — in front of it. */
function frontalCluster(g: SceneGroup): { anchor: DetectedObject; frontal: DetectedObject[] } | null {
  if (g.position !== "center" || g.objs.length < 2) return null;
  const anchor = anchorOf(g);
  const [ax1, , ax2, ay2] = anchor.bbox;
  const frontal: DetectedObject[] = [];
  for (const o of g.objs) {
    if (o === anchor) continue;
    const [ox1, oy1, ox2] = o.bbox;
    const overlapX = Math.max(0, Math.min(ax2, ox2) - Math.max(ax1, ox1));
    const minW = Math.min(ax2 - ax1, ox2 - ox1);
    if (oy1 >= ay2 && overlapX >= 0.3 * minW && o.area <= anchor.area * 0.95) frontal.push(o);
  }
  return frontal.length > 0 ? { anchor, frontal } : null;
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

const POS_TAIL_STRONG: Record<Position, string> = {
  center: "directly ahead",
  left: "on your left",
  right: "on your right",
  below: "a bit lower down, close to you",
  above: "up above you",
};

/** Slightly-left/right only when the box really hugs the middle of its side. */
function posTailFor(o: DetectedObject, scene: Scene): string {
  const w = frameSize(scene).w;
  const cx = cxOf(o, w);
  if (o.position === "left" && cx > 0.28 && cx < 0.42) return "slightly to your left";
  if (o.position === "right" && cx > 0.58 && cx < 0.72) return "slightly to your right";
  return POS_TAIL_STRONG[o.position];
}

function groupClause(g: SceneGroup, lowConf: boolean, scene: Scene): string {
  const cluster = frontalCluster(g);
  if (cluster) {
    const frontNames = joinList([...new Set(cluster.frontal.map((f) => f.name))].map((n) => `a ${n}`));
    const verb = lowConf ? "It looks like there's" : "There's";
    const body = `${verb} a ${cluster.anchor.name} ${POS_TAIL_STRONG.center}, with ${frontNames} in front of it`;
    return body;
  }
  // "There are" only when a kind repeats ("two mugs"); a set of different kinds
  // is a single compound list: "There's a laptop and a keyboard …".
  const multiple = g.names.some((e) => e.count > 1);
  const verb = lowConf ? (multiple ? "It looks like there are" : "It looks like there's")
    : multiple ? "There are" : "There's";
  const tail = g.objs.length === 1 ? posTailFor(g.objs[0], scene) : POS_TAIL_STRONG[g.position];
  const list = joinList(g.names.map((e) => `${countWord(e.count)} ${plural(e.name, e.count)}`));
  const body = `${verb} ${list} ${tail}`;
  return body;
}

/** Whole-scene description: LEFT → CENTER → RIGHT, vertical extras last,
 *  connected like a person listing a room ("…, and there's a …"). */
function describeScene(objs: DetectedObject[], scene: Scene): string {
  const lowConf = objs.every((o) => o.confidence < 0.55);
  return groupByPosition(objs)
    .map((g, i) => {
      const body = groupClause(g, lowConf, scene);
      if (i === 0) return body;
      return `and ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
    })
    .join(", ");
}

/* ------------------------------------------------------------------ *
 * Zone questions ("what's on my left" / "what's above me")            *
 * ------------------------------------------------------------------ */

function requestedZone(query: string): { side?: "left" | "right"; vertical?: "above" | "below" } {
  const q = query.toLowerCase();
  const side = q.match(/(?:on|to) (?:my|your) (left|right)(?: side)?/);
  const vert = q.match(/(?:what(?:'s| is)|anything) (above|below)/) ?? q.match(/\b(above|below)\s+(?:me|us)\b/);
  return {
    side: side ? (side[1] as "left" | "right") : undefined,
    vertical: vert ? (vert[1] as "above" | "below") : undefined,
  };
}

function zoneName(zone: "left" | "right" | "above" | "below"): string {
  switch (zone) {
    case "left": return "on your left";
    case "right": return "on your right";
    case "above": return "above you";
    case "below": return "below you";
  }
}

function zoneList(zone: "left" | "right" | "above" | "below", objs: DetectedObject[]): string {
  if (objs.length === 0) return `I don't see anything ${zoneName(zone)} right now.`;
  const list = joinList(objs.slice(0, 5).map((o) => plural(o.name, 1)));
  const clock = zone === "left" || zone === "right" ? `around ${zone === "left" ? "9 to 10" : "2 to 3"} o'clock, ` : "";
  return `${zoneName(zone)}${clock ? ", " + clock : ""}there's ${list}.`;
}

/* ------------------------------------------------------------------ */
/* Answers                                                             */
/* ------------------------------------------------------------------ */

function sceneDescription(query: string, scene: Scene): WayloResponse {
  const zone = requestedZone(query);

  if (scene.objects.length === 0) {
    return {
      intent: "SCENE_DESCRIPTION",
      text: "I can't make out any objects in the current view. Could you aim the camera at something, or step back a little?",
      referencedObjects: [],
      isMiss: false,
    };
  }

  if (zone.side) {
    const sideObjs = scene.objects
      .filter((o) => (zone.side === "left" ? o.position === "left" : o.position === "right"))
      .sort((a, b) => b.area - a.area);
    return {
      intent: "SCENE_DESCRIPTION",
      text: zoneList(zone.side, sideObjs.slice(0, 5)),
      referencedObjects: sideObjs.slice(0, 5),
      isMiss: false,
    };
  }

  if (zone.vertical) {
    const zoneObjs = scene.objects
      .filter((o) => (zone.vertical === "above" ? o.position === "above" : o.position === "below"))
      .sort((a, b) => b.area - a.area);
    return {
      intent: "SCENE_DESCRIPTION",
      text: zoneList(zone.vertical, zoneObjs.slice(0, 5)),
      referencedObjects: zoneObjs.slice(0, 5),
      isMiss: false,
    };
  }

  const top = scene.objects.slice(0, 7);
  return {
    intent: "SCENE_DESCRIPTION",
    text: `${describeScene(top, scene)}.`,
    referencedObjects: top,
    isMiss: false,
  };
}

/** "Your phone" when the user asked "my phone", "The phone" otherwise. */
function pronounFor(query: string): string {
  return /\b(my|our)\b/.test(query.toLowerCase()) ? "Your" : "The";
}

function findObjectAnswer(query: string, phrase: string, scene: Scene): WayloResponse {
  const found = resolveObjects(phrase, scene);
  const polar = POLAR_RE.test(query.trim()) && !/which (side|position)|where/i.test(query);

  if (found.length === 0) {
    return {
      intent: "FIND_OBJECT",
      text: polar ? `No — I can't see ${phrase} in the current view.` : `I can't see ${phrase} in the current view.`,
      referencedObjects: [],
      isMiss: true,
    };
  }

  // Multiple instances of the same object — name each spot, left → right.
  if (found.length > 1 && new Set(found.map((o) => o.name)).size === 1) {
    const ordered = [...found].sort(
      (a, b) => (a.bbox[0] + a.bbox[2]) / 2 - (b.bbox[0] + b.bbox[2]) / 2
    );
    const name = found[0].name;
    const spots = ordered.map((o) => locateObject(o, scene).phrase);
    const text =
      found.length === 2
        ? `I can see two ${plural(name, 2)}. One is ${spots[0]}, and another is ${spots[1]}.`
        : `I can see ${countWord(found.length)} ${plural(name, found.length)}. One is ${spots[0]}, another is ${spots[1]}, and another is ${spots[2]}.`;
    return { intent: "FIND_OBJECT", text, referencedObjects: ordered, isMiss: false };
  }

  const target = found[0];
  const loc = locateObject(target, scene);
  const name = target.name;
  const partial = target.confidence < 0.62;
  const text = polar
    ? partial
      ? `Yes — I can partially see a ${name} ${loc.phrase}.`
      : `Yes, there's a ${name} ${loc.phrase}.`
    : partial
      ? `I can partially see what appears to be a ${name} ${loc.phrase}.`
      : `${pronounFor(query)} ${name} is ${loc.phrase}.`;

  return { intent: "FIND_OBJECT", text, referencedObjects: [target, ...loc.extra], isMiss: false };
}

function spatialAnswer(phrase: string, scene: Scene): WayloResponse {
  const found = resolveObjects(phrase, scene);
  const target = found[0];
  if (!target) {
    return {
      intent: "SPATIAL_QUERY",
      text: `I can't locate ${phrase} in the current view.`,
      referencedObjects: [],
      isMiss: true,
    };
  }
  const loc = locateObject(target, scene);
  return {
    intent: "SPATIAL_QUERY",
    text: `The ${target.name} is ${loc.phrase}.`,
    referencedObjects: [target, ...loc.extra],
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
  const tail = POS_TAIL_STRONG[target.position];
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
  return {
    intent: "GENERAL_VISUAL_QUERY",
    text: `${describeScene(top, scene)}. Ask me "where is" a specific thing and I'll tell you the spot.`,
    referencedObjects: top,
    isMiss: false,
  };
}

/** Resolve pronouns / "the same one" against recent turns. */
function resolveReference(query: string, ctx: QueryContext): string {
  if (!/(it|that one|this one|the same|those|them|him|her)\b/.test(query.toLowerCase())) return query;
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