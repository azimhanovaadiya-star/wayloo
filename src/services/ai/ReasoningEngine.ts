/**
 * WAYLO Reasoning Engine — deterministic, local, testable.
 * Hard rule (PRD): never invent objects, positions, or text that are not in the
 * supplied scene. Every noun in an answer comes from Scene.objects.
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
const SPATIAL_RE = /(left|right|side|corner|which (side|way)|position of)/i;
const FIND_RE =
  /(where|find|look(ing)? for|do you (see|spot|have)|is there|is my|have you seen|locate|can you (see|find|spot)|find me)/i;
const OBSTACLE_RE =
  /(obstacle|block(ing|ed|s)?|in (my|the) way|clear path|walkable|walk|bump into|stair|step|doorway)/i;
const IDENTIFY_RE =
  /(what('| i)?s (this|that)|identify (this|that)|what (am|are) (i|you) (holding|pointing at)|is this (a|an))/i;

function classifyIntent(query: string): Intent {
  const q = query.toLowerCase();
  if (READ_TEXT_RE.test(q)) return "READ_TEXT";
  if (SCENE_RE.test(q)) return "SCENE_DESCRIPTION";
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

const POSITION_PHRASE: Record<string, string> = {
  left: "on your left",
  center: "straight ahead of you",
  right: "on your right",
  above: "a bit higher up, above you",
  below: "lower down, in front of you",
};

function directionPhrase(p: DetectedObject["position"]): string {
  return POSITION_PHRASE[p] ?? "in view";
}

function objectCountWord(n: number): string {
  if (n <= 1) return "a";
  if (n === 2) return "two";
  if (n === 3) return "three";
  return `${n}`;
}

function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Normalized distance between two object centres (relative to larger box). */
function dist(a: DetectedObject, b: DetectedObject): number {
  const [ax1, ay1, ax2, ay2] = a.bbox;
  const [bx1, by1, bx2, by2] = b.bbox;
  const ac = [(ax1 + ax2) / 2, (ay1 + ay2) / 2];
  const bc = [(bx1 + bx2) / 2, (by1 + by2) / 2];
  const frame = Math.max(ax2 - ax1, ay2 - ay1, bx2 - bx1, by2 - by1, 1);
  return Math.hypot(ac[0] - bc[0], ac[1] - bc[1]) / frame;
}

function sceneDescription(scene: Scene): WayloResponse {
  if (scene.objects.length === 0) {
    return {
      intent: "SCENE_DESCRIPTION",
      text: "I can't make out any objects in the current view. Could you aim the camera at something, or step back a little?",
      referencedObjects: [],
      isMiss: false,
    };
  }
  const top = scene.objects.slice(0, 5);
  const grouped = new Map<string, DetectedObject[]>();
  for (const o of top) {
    grouped.set(o.name, [...(grouped.get(o.name) ?? []), o]);
  }
  const parts: string[] = [];
  for (const [name, objs] of grouped) {
    const dir = objs.length === 1 ? ` ${directionPhrase(objs[0].position)}` : "";
    parts.push(`${objectCountWord(objs.length)} ${name}${objs.length > 1 ? "s" : ""}${dir}`);
  }
  return {
    intent: "SCENE_DESCRIPTION",
    text: `In front of you I see ${joinObjects(parts)}.`,
    referencedObjects: top,
    isMiss: false,
  };
}

function findObjectAnswer(phrase: string, scene: Scene): WayResponse {
  const found = resolveObjects(phrase, scene);
  const target = found[0];
  if (!target) {
    return {
      intent: "FIND_OBJECT",
      text: `I can't see ${phrase} in the current view. It may be outside the frame or hidden behind something.`,
      referencedObjects: [],
      isMiss: true,
    };
  }
  const near = scene.objects
    .filter((o) => o !== target)
    .sort((a, b) => dist(target, a) - dist(target, b))[0];
  let extra = "";
  if (near && dist(target, near) < 0.28) {
    const [tx1, , tx2] = target.bbox;
    const [nx1, , nx2] = near.bbox;
    const tc = (tx1 + tx2) / 2;
    const nc = (nx1 + nx2) / 2;
    const side = tc < nc ? "just left of" : tc > nc ? "just to the right of" : "right against";
    extra = ` It's ${side} the ${near.name}.`;
  }
  return {
    intent: "FIND_OBJECT",
    text: `I see your ${target.name}, ${directionPhrase(target.position)}.${extra}`,
    referencedObjects: [target, ...(near && dist(target, near) < 0.28 ? [near] : [])],
    isMiss: false,
  };
}

function identifyObject(scene: Scene): WayResponse {
  if (scene.objects.length === 0) {
    return {
      intent: "IDENTIFY_OBJECT",
      text: "I don't see an object to identify in the current view. Point me at something and ask again.",
      referencedObjects: [],
      isMiss: true,
    };
  }
  const target = [...scene.objects].sort((a, b) => b.area - a.area)[0];
  const unsure = target.confidence < 0.6 ? " I'm not fully certain, " : " ";
  return {
    intent: "IDENTIFY_OBJECT",
    text: `That's a ${target.name},${unsure}${directionPhrase(target.position)}.`,
    referencedObjects: [target],
    isMiss: false,
  };
}

function spatialAnswer(phrase: string, scene: Scene): WayResponse {
  const target = resolveObjects(phrase, scene)[0];
  if (!target) {
    return {
      intent: "SPATIAL_QUERY",
      text: `I can't locate ${phrase} in the current view.`,
      referencedObjects: [],
      isMiss: true,
    };
  }
  const near = scene.objects
    .filter((o) => o !== target)
    .sort((a, b) => dist(target, a) - dist(target, b))[0];
  if (near && dist(target, near) < 0.35) {
    const [tx1, , tx2] = target.bbox;
    const [nx1, , nx2] = near.bbox;
    const tc = (tx1 + tx2) / 2;
    const nc = (nx1 + nx2) / 2;
    const rel = tc < nc - 0.04 ? "on the left of" : tc > nc + 0.04 ? "on the right of" : "right next to";
    return {
      intent: "SPATIAL_QUERY",
      text: `The ${target.name} is ${rel} the ${near.name}.`,
      referencedObjects: [target, near],
      isMiss: false,
    };
  }
  return {
    intent: "SPATIAL_QUERY",
    text: `The ${target.name} is ${directionPhrase(target.position)}.`,
    referencedObjects: [target],
    isMiss: false,
  };
}

function obstacleAnswer(scene: Scene): WayResponse {
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

function generalAnswer(scene: Scene): WayResponse {
  if (scene.objects.length === 0) {
    return {
      intent: "GENERAL_VISUAL_QUERY",
      text: "The current view doesn't show anything I can name. Aim the camera at something and ask again.",
      referencedObjects: [],
      isMiss: false,
    };
  }
  const top = scene.objects.slice(0, 3);
  const names = joinObjects(top.map((o) => objectCountWord(1) + " " + o.name));
  return {
    intent: "GENERAL_VISUAL_QUERY",
    text: `Right now I can see ${names}. Ask me "where is" one of them and I'll point it out.`,
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
): WayResponse {
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
  if (intent === "SCENE_DESCRIPTION") return sceneDescription(scene);
  if (intent === "FIND_OBJECT") return findObjectAnswer(extractTargetPhrase(resolved) ?? resolved, scene);
  if (intent === "SPATIAL_QUERY") return spatialAnswer(extractTargetPhrase(resolved) ?? resolved, scene);
  if (intent === "OBSTACLE_QUERY") return obstacleAnswer(scene);
  if (intent === "IDENTIFY_OBJECT") return identifyObject(scene);
  return generalAnswer(scene);
}

type WayResponse = WayloResponse;

export { classifyIntent };