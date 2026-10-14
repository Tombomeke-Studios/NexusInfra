import type { ResourceLimits } from './api';

/**
 * A server's size as the Resources editor holds it (#381): CPU and memory, each
 * in whichever unit the person is thinking in (#275). Both units are kept while
 * editing so switching back and forth does not lose what was typed; only the
 * chosen one is ever sent.
 */
export interface LimitChoice {
  ramUnit: 'mb' | 'percent';
  ramMb: number;
  ramPercent: number;
  cpuUnit: 'cores' | 'percent';
  cpuCores: number;
  cpuPercent: number;
}

/**
 * The editor's starting point, in the unit the server was created with.
 *
 * The absolute amount wins when both are stored, because it is what the API
 * enforces. A server with no cap opens as 0 — "no limit" — rather than as a
 * made-up default that would be saved the moment someone pressed Save.
 */
export function limitChoiceFrom(limits: ResourceLimits | undefined): LimitChoice {
  const ramMb = limits?.ramMb && limits.ramMb > 0 ? limits.ramMb : 0;
  const cpuCores = limits?.cpuCores && limits.cpuCores > 0 ? limits.cpuCores : 0;
  return {
    ramUnit: ramMb || !limits?.ramPercent ? 'mb' : 'percent',
    ramMb,
    ramPercent: limits?.ramPercent ?? 50,
    cpuUnit: cpuCores || !limits?.cpuPercent ? 'cores' : 'percent',
    cpuCores,
    cpuPercent: limits?.cpuPercent ?? 50,
  };
}

/**
 * The full limits to send. `PATCH /deployments/:id` replaces `resourceLimits`
 * whole, so everything this editor does not touch — swap, IO priority, restart
 * and OOM policy — is carried through as it was.
 *
 * Only the chosen unit goes out: the absolute amount wins server-side, so a
 * stale `ramMb` left beside a new `ramPercent` would silently keep the old size.
 */
export function withSizeLimits(existing: ResourceLimits | undefined, choice: LimitChoice): ResourceLimits {
  const rest: ResourceLimits = { ...existing };
  delete rest.ramMb;
  delete rest.ramPercent;
  delete rest.cpuCores;
  delete rest.cpuPercent;
  return {
    ...rest,
    ...(choice.cpuUnit === 'cores' ? (choice.cpuCores > 0 ? { cpuCores: choice.cpuCores } : {}) : { cpuPercent: choice.cpuPercent }),
    ...(choice.ramUnit === 'mb' ? (choice.ramMb > 0 ? { ramMb: choice.ramMb } : {}) : { ramPercent: choice.ramPercent }),
  };
}

/**
 * The memory cap in MB this choice gives on a node with `nodeTotalMb`, or null
 * when there is none or it cannot be known — mirrors `containerMemoryMb` in the
 * orchestrator, which derives the Java heap from the same number (#308).
 */
export function capMbOf(choice: LimitChoice, nodeTotalMb: number | null | undefined): number | null {
  if (choice.ramUnit === 'mb') return choice.ramMb > 0 ? Math.round(choice.ramMb) : null;
  if (!nodeTotalMb || nodeTotalMb <= 0 || choice.ramPercent <= 0) return null;
  return Math.round((choice.ramPercent / 100) * nodeTotalMb);
}
