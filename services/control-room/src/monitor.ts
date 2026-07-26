// Monitor core for the Control Room. Extracted from index.ts so the tracking and
// uptime maths are pure and unit-testable: every method takes an explicit `now`
// (epoch ms) rather than reading the clock, so tests are deterministic.
//
// Status thresholds follow CONCEPTS/infrastructure-platform/architecture.md and
// are unchanged: healthy < 3s since last beat ≤ degraded < 10s ≤ offline.

export type Status = 'healthy' | 'degraded' | 'offline';

export const DEGRADED_MS = 3000;
export const OFFLINE_MS = 10000;

/** Derive a source's status from how long ago it was last seen. */
export function statusFor(lastSeen: number, now: number): Status {
  const age = now - lastSeen;
  if (age >= OFFLINE_MS) return 'offline';
  if (age >= DEGRADED_MS) return 'degraded';
  return 'healthy';
}

/**
 * Exact healthy time within the span `[from, to]` for a source last seen at
 * `lastSeen`. A source counts as healthy only for `DEGRADED_MS` after each beat,
 * so the healthy window is `[lastSeen, lastSeen + DEGRADED_MS]` — this returns the
 * overlap of the two intervals.
 *
 * Computing the overlap (rather than attributing a whole span to the status that
 * held at its start) keeps the accounting correct even when spans straddle a
 * threshold or evaluation is coarse/irregular.
 */
export function healthyOverlapMs(lastSeen: number, from: number, to: number): number {
  const healthyUntil = lastSeen + DEGRADED_MS;
  return Math.max(0, Math.min(to, healthyUntil) - Math.max(from, lastSeen));
}

/** A recorded status change for a source. */
export interface Transition {
  from: Status;
  to: Status;
  /** When the change was observed (epoch ms). */
  at: number;
}

export interface SourceStatus {
  source: string;
  status: Status;
  lastSeenMsAgo: number;
  /** Share of observed time this source was healthy, 0–100 (rounded to 2dp). */
  uptimePercent: number;
}

export interface SourceUptime extends SourceStatus {
  /** When this source was first observed (epoch ms). */
  firstSeen: number;
  /** Total observed span in ms (first observation → now). */
  observedMs: number;
  /** Cumulative ms spent healthy. */
  healthyMs: number;
  /** Most recent transitions, oldest first, capped by `historyLimit`. */
  transitions: Transition[];
}

interface Tracked {
  source: string;
  lastSeen: number;
  firstSeen: number;
  /** Status as of `lastEvaluated` — the basis for attributing elapsed time. */
  status: Status;
  lastEvaluated: number;
  healthyMs: number;
  observedMs: number;
  transitions: Transition[];
}

export interface MonitorOptions {
  /** Max transitions retained per source (ring buffer) so memory stays bounded. */
  historyLimit?: number;
}

const DEFAULT_HISTORY_LIMIT = 50;

/**
 * Tracks every heartbeat source: liveness, derived status, status transitions and
 * cumulative uptime. Time is attributed by advancing each source's clock — either
 * on a heartbeat or on an explicit `evaluate(now)` tick — and crediting the span
 * since the last evaluation to whatever status held during it.
 */
export class Monitor {
  private sources = new Map<string, Tracked>();
  private readonly historyLimit: number;

  constructor(options: MonitorOptions = {}) {
    this.historyLimit = Math.max(1, options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
  }

  /** Record a heartbeat from `source` at `now`. */
  heartbeat(source: string, now: number): void {
    const tracked = this.sources.get(source);
    if (!tracked) {
      this.sources.set(source, {
        source,
        lastSeen: now,
        firstSeen: now,
        status: 'healthy',
        lastEvaluated: now,
        healthyMs: 0,
        observedMs: 0,
        transitions: [],
      });
      return;
    }
    // Credit the span up to now against the status that held during it, then the
    // beat makes the source healthy again.
    this.advance(tracked, now);
    tracked.lastSeen = now;
    this.transitionTo(tracked, 'healthy', now);
  }

  /**
   * Advance every source's clock to `now`, recording any status changes. Called on
   * a timer in production and directly in tests; safe to call repeatedly.
   */
  evaluate(now: number): void {
    for (const tracked of this.sources.values()) {
      this.advance(tracked, now);
      this.transitionTo(tracked, statusFor(tracked.lastSeen, now), now);
    }
  }

  /** Live status of every source, sorted by name. */
  snapshot(now: number): SourceStatus[] {
    return this.uptimes(now).map(({ source, status, lastSeenMsAgo, uptimePercent }) => ({ source, status, lastSeenMsAgo, uptimePercent }));
  }

  /** Full uptime detail for every source, sorted by name. */
  uptimes(now: number): SourceUptime[] {
    return Array.from(this.sources.values())
      .map((t) => {
        // Report against a projected clock without mutating state, so a read is
        // never order-dependent with evaluate().
        const pendingMs = Math.max(0, now - t.lastEvaluated);
        const healthyMs = t.healthyMs + healthyOverlapMs(t.lastSeen, t.lastEvaluated, now);
        const observedMs = t.observedMs + pendingMs;
        return {
          source: t.source,
          status: statusFor(t.lastSeen, now),
          lastSeenMsAgo: Math.max(0, now - t.lastSeen),
          uptimePercent: observedMs > 0 ? Math.round((healthyMs / observedMs) * 10000) / 100 : 100,
          firstSeen: t.firstSeen,
          observedMs,
          healthyMs,
          transitions: [...t.transitions],
        };
      })
      .sort((a, b) => a.source.localeCompare(b.source));
  }

  /** Uptime detail for one source, or null if never seen. */
  get(source: string, now: number): SourceUptime | null {
    return this.uptimes(now).find((u) => u.source === source) ?? null;
  }

  /**
   * Credit the span since the last evaluation, splitting it exactly at the healthy
   * threshold rather than attributing it all to the status held at the start.
   */
  private advance(tracked: Tracked, now: number): void {
    const elapsed = now - tracked.lastEvaluated;
    if (elapsed <= 0) return;
    tracked.observedMs += elapsed;
    tracked.healthyMs += healthyOverlapMs(tracked.lastSeen, tracked.lastEvaluated, now);
    tracked.lastEvaluated = now;
  }

  /** Move a source to `status`, recording the transition when it actually changes. */
  private transitionTo(tracked: Tracked, status: Status, now: number): void {
    if (tracked.status === status) return;
    tracked.transitions.push({ from: tracked.status, to: status, at: now });
    if (tracked.transitions.length > this.historyLimit) tracked.transitions.shift();
    tracked.status = status;
  }
}
