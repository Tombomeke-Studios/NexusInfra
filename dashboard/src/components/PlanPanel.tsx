import { useEffect, useState } from 'react';
import { getEntitlements, type EntitlementUsage, type Entitlements } from '../api';
import { chargingSentence, countOf, formatMb, ramVerdict } from '../plan';

// What your plan allows, beside the size you are choosing (hosted, #297).
//
// The form used to ask for CPU and RAM as a share of a node and say nothing
// about the plan, so a customer chose without the boundary in view and learned
// it from a refusal — or never learned what they had paid for. This shows the
// ceilings, what is already spent, whether the server being sized still fits,
// and how any of it is charged.
//
// Hosted-only. A community build aliases this file to PlanPanel.stub.tsx, so
// none of it reaches that bundle (#190).

export interface PlanPanelProps {
  /** The memory cap being chosen, in MB on the target node; null when it cannot be known yet. */
  requestedRamMb: number | null;
  /** Set the form's memory cap, in MB — offered when the chosen size does not fit. */
  onUseRamMb?: (mb: number) => void;
}

export function PlanPanel({ requestedRamMb, onUseRamMb }: PlanPanelProps) {
  const [plan, setPlan] = useState<{ entitlements: Entitlements; usage: EntitlementUsage } | null>(null);

  useEffect(() => {
    let live = true;
    // A 404 means no plan applies (or the billing service is down, in which case
    // nothing is enforced either) — so there is nothing to show, not an error.
    getEntitlements()
      .then((p) => live && setPlan(p))
      .catch(() => live && setPlan(null));
    return () => {
      live = false;
    };
  }, []);

  if (!plan) return null;
  const { entitlements: e, usage: u } = plan;
  const verdict = ramVerdict(e, u, requestedRamMb);
  const serversFull = e.maxServers != null && u.servers >= e.maxServers;
  const leftMb = e.maxRamMb == null ? 0 : Math.max(0, e.maxRamMb - u.ramMb);

  return (
    <section
      aria-label="Your plan"
      style={{ marginBottom: 20, padding: '14px 16px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', background: 'var(--color-surface-2)' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <span style={{ fontSize: '.82rem', fontWeight: 600 }}>Your plan · {e.planName}</span>
        <span style={{ fontSize: '.74rem', color: 'var(--color-text-subtle)' }}>what this account may use</span>
      </div>

      <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px 16px', margin: 0, fontSize: '.8rem' }}>
        <div>
          <dt style={{ color: 'var(--color-text-subtle)' }}>Servers</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{countOf(u.servers, e.maxServers)}</dd>
        </div>
        <div>
          <dt style={{ color: 'var(--color-text-subtle)' }}>Memory committed</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{e.maxRamMb == null ? formatMb(u.ramMb) : `${formatMb(u.ramMb)} of ${formatMb(e.maxRamMb)}`}</dd>
        </div>
        <div>
          <dt style={{ color: 'var(--color-text-subtle)' }}>Databases</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{countOf(u.databases, e.maxDatabases)}</dd>
        </div>
        <div>
          <dt style={{ color: 'var(--color-text-subtle)' }}>Backups per server</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{e.maxBackupsPerServer == null ? 'no limit' : `newest ${e.maxBackupsPerServer} kept`}</dd>
        </div>
      </dl>

      {serversFull && (
        <div role="alert" style={{ marginTop: 10, fontSize: '.8rem', fontWeight: 550, color: 'var(--color-danger)' }}>
          ⚠ Your plan's {e.maxServers} servers are all in use. Delete one to create another.
        </div>
      )}
      {verdict.kind === 'over' && (
        <div role="alert" style={{ marginTop: 10, fontSize: '.8rem', fontWeight: 550, color: 'var(--color-danger)' }}>
          ⚠ This server needs {formatMb(verdict.neededMb)} of memory, and your plan has {formatMb(verdict.leftMb)} of its {formatMb(verdict.maxMb)} left.
        </div>
      )}
      {verdict.kind === 'uncapped' && (
        <div role="alert" style={{ marginTop: 10, fontSize: '.8rem', fontWeight: 550, color: 'var(--color-danger)' }}>
          ⚠ Your plan includes {formatMb(verdict.maxMb)} of memory across your servers, so this server needs a memory limit.
        </div>
      )}
      {/* A way out, not only a warning: the form's defaults are a share of the
          node, which on a large node is more than a small plan holds. */}
      {(verdict.kind === 'over' || verdict.kind === 'uncapped') && onUseRamMb && leftMb > 0 && (
        <button type="button" className="btn btn--ghost btn--sm" style={{ marginTop: 8 }} onClick={() => onUseRamMb(leftMb)}>
          Use the {formatMb(leftMb)} left
        </button>
      )}
      {verdict.kind === 'fits' && (
        <div style={{ marginTop: 10, fontSize: '.8rem', color: 'var(--color-text-subtle)' }}>
          With this server: {formatMb(verdict.afterMb)} of {formatMb(verdict.maxMb)} committed.
        </div>
      )}
      {e.maxBackupsPerServer != null && (
        <div style={{ marginTop: 6, fontSize: '.76rem', color: 'var(--color-text-subtle)' }}>
          A backup beyond the newest {e.maxBackupsPerServer} replaces the oldest, so scheduled backups keep running.
        </div>
      )}
      <p style={{ margin: '10px 0 0', fontSize: '.76rem', color: 'var(--color-text-subtle)' }}>{chargingSentence(e.charging)}</p>
    </section>
  );
}
