/**
 * Short-term context memory (PRD §103): previous scene + last Q/A pair,
 * in-memory only, capped ~2 turns, cleared on page close. Nothing persisted.
 */

import type { Scene, WayloTurn } from "../../types";

const MAX_TURNS = 2;

export class SessionContext {
  private scene: Scene | null = null;
  private turns: WayloTurn[] = [];

  get lastScene(): Scene | null {
    return this.scene;
  }

  get history(): WayloTurn[] {
    return this.turns;
  }

  rememberScene(scene: Scene | null): void {
    this.scene = scene;
  }

  rememberTurn(turn: WayloTurn): void {
    this.turns = [...this.turns, turn].slice(-MAX_TURNS);
  }

  clear(): void {
    this.scene = null;
    this.turns = [];
  }
}

export const sessionContext = new SessionContext();