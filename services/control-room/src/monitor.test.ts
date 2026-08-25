import { describe, it, expect } from 'vitest';
import { DEGRADED_MS, healthyOverlapMs, Monitor, OFFLINE_MS, statusFor } from './monitor.js';

// All times are explicit epoch-ms so these tests are deterministic — no real clock.
const T0 = 1_800_000_000_000;

describe('statusFor thresholds', () => {
  it('is healthy below the degraded threshold', () => {
    expect(statusFor(T0, T0)).toBe('healthy');
    expect(statusFor(T0, T0 + DEGRADED_MS - 1)).toBe('healthy');
  });

  it('is degraded from 3s up to the offline threshold', () => {
    expect(statusFor(T0, T0 + DEGRADED_MS)).toBe('degraded');
    expect(statusFor(T0, T0 + OFFLINE_MS - 1)).toBe('degraded');
  });

  it('is offline from 10s', () => {
    expect(statusFor(T0, T0 + OFFLINE_MS)).toBe('offline');
    expect(statusFor(T0, T0 + 60_000)).toBe('offline');
  });
});

describe('healthyOverlapMs', () => {
  it('counts a span fully inside the healthy window', () => {
    expect(healthyOverlapMs(T0, T0, T0 + 1000)).toBe(1000);
  });

  it('splits a span that straddles the degraded threshold', () => {
    // Span 0→10s, but only the first 3s after the beat count as healthy.
    expect(healthyOverlapMs(T0, T0, T0 + 10_000)).toBe(DEGRADED_MS);
  });

  it('is zero for a span entirely past the healthy window', () => {
    expect(healthyOverlapMs(T0, T0 + 5000, T0 + 9000)).toBe(0);
  });

  it('is zero for an empty or reversed span', () => {
    expect(healthyOverlapMs(T0, T0 + 1000, T0 + 1000)).toBe(0);
    expect(healthyOverlapMs(T0, T0 + 2000, T0 + 1000)).toBe(0);
  });
});

describe('Monitor tracking', () => {
  it('reports an unknown source as absent', () => {
    const m = new Monitor();
    expect(m.get('nobody', T0)).toBeNull();
    expect(m.snapshot(T0)).toEqual([]);
  });

  it('tracks a source from its first heartbeat as healthy at 100%', () => {
    const m = new Monitor();
    m.heartbeat('orchestrator', T0);
    const [s] = m.snapshot(T0);
    expect(s.source).toBe('orchestrator');
    expect(s.status).toBe('healthy');
    expect(s.lastSeenMsAgo).toBe(0);
    expect(s.uptimePercent).toBe(100);
  });

  it('sorts sources by name', () => {
    const m = new Monitor();
    m.heartbeat('node-agent', T0);
    m.heartbeat('control-room', T0);
    m.heartbeat('orchestrator', T0);
    expect(m.snapshot(T0).map((s) => s.source)).toEqual(['control-room', 'node-agent', 'orchestrator']);
  });

  it('ages a silent source through degraded to offline', () => {
    const m = new Monitor();
    m.heartbeat('svc', T0);
    expect(m.snapshot(T0 + 1000)[0].status).toBe('healthy');
    expect(m.snapshot(T0 + 5000)[0].status).toBe('degraded');
    expect(m.snapshot(T0 + 20_000)[0].status).toBe('offline');
  });

  it('reads consistently whether or not evaluate() ran (projected clock)', () => {
    const withEval = new Monitor();
    const withoutEval = new Monitor();
    withEval.heartbeat('svc', T0);
    withoutEval.heartbeat('svc', T0);
    withEval.evaluate(T0 + 20_000);
    expect(withEval.snapshot(T0 + 20_000)[0]).toEqual(withoutEval.snapshot(T0 + 20_000)[0]);
  });
});

describe('Monitor uptime maths', () => {
  it('stays at 100% while a source beats steadily', () => {
    const m = new Monitor();
    for (let i = 0; i <= 10; i++) m.heartbeat('svc', T0 + i * 1000);
    const u = m.get('svc', T0 + 10_000)!;
    expect(u.uptimePercent).toBe(100);
    expect(u.observedMs).toBe(10_000);
    expect(u.healthyMs).toBe(10_000);
  });

  it('credits downtime once a source goes unhealthy', () => {
    const m = new Monitor();
    m.heartbeat('svc', T0);
    // Healthy for the first 3s, then degraded/offline for the next 7s.
    m.evaluate(T0 + DEGRADED_MS); // transition healthy → degraded at 3s
    m.evaluate(T0 + 10_000);
    const u = m.get('svc', T0 + 10_000)!;
    expect(u.observedMs).toBe(10_000);
    expect(u.healthyMs).toBe(DEGRADED_MS); // only the first 3s counted as healthy
    expect(u.uptimePercent).toBe(30);
  });

  it('recovers uptime as the source resumes beating', () => {
    const m = new Monitor();
    m.heartbeat('svc', T0);
    m.evaluate(T0 + 10_000); // 3s healthy, then 7s down
    // Now beat every second for another 10s.
    for (let i = 1; i <= 10; i++) m.heartbeat('svc', T0 + 10_000 + i * 1000);
    const u = m.get('svc', T0 + 20_000)!;
    expect(u.observedMs).toBe(20_000);
    // 3s healthy at the start + 9s covered by the beats from 12s onward. The
    // second between the 10s mark and the first recovery beat at 11s is downtime:
    // the source was still offline until that beat landed.
    expect(u.healthyMs).toBe(12_000);
    expect(u.uptimePercent).toBe(60);
  });

  it('rounds uptime to two decimal places', () => {
    const m = new Monitor();
    m.heartbeat('svc', T0);
    m.evaluate(T0 + DEGRADED_MS); // 3s healthy
    m.evaluate(T0 + 7000); // + 4s down → 3/7
    expect(m.get('svc', T0 + 7000)!.uptimePercent).toBe(42.86);
  });
});

describe('Monitor transitions', () => {
  it('records each status change with its direction and time', () => {
    const m = new Monitor();
    m.heartbeat('svc', T0);
    m.evaluate(T0 + DEGRADED_MS);
    m.evaluate(T0 + OFFLINE_MS);
    m.heartbeat('svc', T0 + 12_000);

    expect(m.get('svc', T0 + 12_000)!.transitions).toEqual([
      { from: 'healthy', to: 'degraded', at: T0 + DEGRADED_MS },
      { from: 'degraded', to: 'offline', at: T0 + OFFLINE_MS },
      { from: 'offline', to: 'healthy', at: T0 + 12_000 },
    ]);
  });

  it('does not record a transition when the status is unchanged', () => {
    const m = new Monitor();
    m.heartbeat('svc', T0);
    m.evaluate(T0 + 500);
    m.evaluate(T0 + 1000); // still healthy throughout
    expect(m.get('svc', T0 + 1000)!.transitions).toEqual([]);
  });

  it('caps retained history, dropping the oldest transitions', () => {
    const m = new Monitor({ historyLimit: 3 });
    let t = T0;
    // Each cycle produces two transitions (healthy→offline, offline→healthy).
    for (let i = 0; i < 5; i++) {
      m.heartbeat('svc', t);
      t += OFFLINE_MS;
      m.evaluate(t);
    }
    // 9 transitions occurred; only the newest 3 are retained.
    const { transitions } = m.get('svc', t)!;
    expect(transitions).toHaveLength(3);
    // The oldest retained entry is from the 4th cycle, proving the earlier ones
    // were dropped rather than the newest being discarded.
    expect(transitions[0].at).toBe(T0 + 4 * OFFLINE_MS);
    expect(transitions.at(-1)).toEqual({ from: 'healthy', to: 'offline', at: T0 + 5 * OFFLINE_MS });
  });
});
