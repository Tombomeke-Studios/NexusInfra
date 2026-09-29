import { isHosted } from 'shared';
import { committedRamMb } from './capacity.js';
import type { DeploymentView, NodeRecord } from './types.js';

// What a hosted plan entitles an account to, measured against what it has
// (#297). The Billing Bridge owns the plan; the Orchestrator owns the servers,
// so it is the one that can say how much of the plan is spent.
//
// Pure except for `fetchEntitlements`: plan and records in, a verdict or a
// sentence out, so every rule here is unit-tested without a bridge.
//
// **Who is measured.** A server counts against its *owner's* plan, whoever is
// making the change — an administrator resizing somebody's server spends that
// person's memory, not their own. And the platform role buys no exemption: it
// is standing in the installation (managing nodes and accounts), not a bigger
// plan. An operator who wants more for an account gives it a bigger plan, where
// it shows up in the bill as well.

/** How the plan charges (mirrors billing-bridge `ChargingModel`). */
export interface ChargingModel {
  basis: 'runtime-hours';
  pricePerHour: number;
  currency: string;
  freeHoursPerMonth: number;
  sizeFactor: { standardCpuPercent: number; standardRamPercent: number; minimum: number };
}

export interface Entitlements {
  planId: string;
  planName: string;
  maxServers: number | null;
  maxDatabases: number | null;
  /** Memory an account may commit across all its servers; null for no ceiling. */
  maxRamMb: number | null;
  maxBackupsPerServer: number | null;
  charging: ChargingModel;
}

export interface EntitlementUsage {
  servers: number;
  databases: number;
  /** Memory committed to the account's servers, in MB. */
  ramMb: number;
  /** Servers whose memory cannot be counted: no cap, or a percentage of a node that never reported its size. */
  uncappedServers: number;
}

/** The ceiling a plan puts on one server's backups — used as a retention limit. */
export type BackupCeiling = number | null;

/** The memory one server holds, in MB; 0 when it has no cap that can be counted. */
export function serverRamMb(deployment: Pick<DeploymentView, 'resourceLimits' | 'nodeId'>, nodes: NodeRecord[]): number {
  const node = nodes.find((n) => n.id === deployment.nodeId);
  return committedRamMb(deployment.resourceLimits, node?.ramTotalMb);
}

/** What an account has spent of its plan. `exceptId` leaves one server out — the one being changed. */
export function usageFor(
  userId: string,
  deployments: DeploymentView[],
  nodes: NodeRecord[],
  databases: number,
  exceptId?: string
): EntitlementUsage {
  const own = deployments.filter((d) => d.userId === userId && d.id !== exceptId);
  let ramMb = 0;
  let uncappedServers = 0;
  for (const d of own) {
    const mb = serverRamMb(d, nodes);
    if (mb > 0) ramMb += mb;
    else uncappedServers += 1;
  }
  return { servers: own.length, databases, ramMb, uncappedServers };
}

const gb = (mb: number) => (mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`);

/**
 * Why a server holding `ramMb` does not fit the plan, or null when it does.
 *
 * An uncapped server is refused outright under a memory ceiling: it can take
 * the whole node, so counting it as zero would let one server spend every
 * account's memory — and counting it as anything else would be a made-up number.
 */
export function ramProblem(entitlements: Entitlements | null, usage: EntitlementUsage, ramMb: number): string | null {
  const max = entitlements?.maxRamMb;
  if (max == null) return null;
  if (!(ramMb > 0)) {
    return `your plan includes ${gb(max)} of memory across your servers, so a server needs a memory limit`;
  }
  const left = Math.max(0, max - usage.ramMb);
  if (ramMb > left) {
    return `this server needs ${gb(ramMb)} of memory, and your plan has ${gb(left)} of its ${gb(max)} left`;
  }
  return null;
}

/**
 * Fetch an account's entitlements from the Billing Bridge, or null when there
 * are none to apply: the community edition, or a bridge that cannot answer.
 *
 * Failing open is the same decision the quota check made (#148) — a billing
 * outage must not stop people running servers. It is logged, because a plan
 * silently unenforced is a bill silently wrong.
 */
export async function fetchEntitlements(bridgeUrl: string, userId: string): Promise<Entitlements | null> {
  if (!isHosted()) return null;
  try {
    const r = await fetch(`${bridgeUrl}/billing/${encodeURIComponent(userId)}/entitlements`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as Entitlements;
  } catch (err) {
    console.warn(`[Orchestrator] plan entitlements unavailable, not enforced: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Why changing a server from `beforeMb` to `afterMb` of memory breaks the plan,
 * or null. Only a change that asks for *more* is measured: an account already
 * over its plan (the plan shrank, or a node grew under a percentage cap) must
 * still be able to shrink a server, even if one step does not bring it all
 * the way back.
 */
export function ramChangeProblem(entitlements: Entitlements | null, usageOfOthers: EntitlementUsage, beforeMb: number, afterMb: number): string | null {
  if (entitlements?.maxRamMb == null) return null;
  const asksForMore = afterMb <= 0 ? beforeMb > 0 : beforeMb > 0 && afterMb > beforeMb;
  if (!asksForMore) return null;
  return ramProblem(entitlements, usageOfOthers, afterMb);
}
