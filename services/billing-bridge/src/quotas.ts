import type { BillingPlan } from './pricing.js';

// Pure plan-quota checks (hosted edition). The Orchestrator enforces these at
// create-time (#148) by asking the Billing Bridge; keeping the rule pure here
// means one tested definition of "over quota".

export type QuotaResource = 'servers' | 'databases';

/** The cap this plan places on a resource. */
export function quotaLimit(plan: BillingPlan, resource: QuotaResource): number {
  return resource === 'servers' ? plan.maxServers : plan.maxDatabases;
}

/**
 * Whether creating one more of `resource` stays within the plan.
 * `current` is how many the user already has.
 */
export function withinQuota(plan: BillingPlan, resource: QuotaResource, current: number): boolean {
  return current < quotaLimit(plan, resource);
}
