/**
 * PerformanceTracker — wall-clock latency legs for the demo panel.
 * Every value is measured; null = the leg never ran (displays as N/A).
 * Never fabricated (PRD §performance).
 */

export interface MetricMark {
  name: string;
  start: number;
  end: number;
  ms: number;
}

export class PerformanceTracker {
  private legs: Map<string, { start: number; end?: number }> = new Map();

  begin(name: string): void {
    this.legs.set(name, { start: performance.now() });
  }

  end(name: string): number {
    const leg = this.legs.get(name);
    if (!leg) return -1;
    const end = performance.now();
    leg.end = end;
    return Math.round(end - leg.start);
  }

  /** Elapsed for a finished leg, or null if it never ran. */
  ms(name: string): number | null {
    const leg = this.legs.get(name);
    if (!leg?.end) return null;
    return Math.round(leg.end - leg.start);
  }

  reset(): void {
    this.legs.clear();
  }
}