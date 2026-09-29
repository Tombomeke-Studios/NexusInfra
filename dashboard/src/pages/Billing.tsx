import { useCallback, useEffect, useRef, useState } from 'react';
import { getWallet, getUsage, getLedger, topUp, getEntitlements, type CreditWallet, type BillingUsage, type LedgerEntry, type ChargingModel } from '../api';
import { chargingSentence } from '../plan';
import { useToast } from '../components/Toast';
import { formatRelative } from '../format';

// Billing page (#149) — hosted edition only (the route is gated in routes.tsx via
// useEdition). Shows the credit balance, a top-up form (funded via FinVault), the
// usage/cost breakdown for the current cycle, and the payment history.

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
}

const TOP_UP_PRESETS = [5, 10, 25, 50];

/**
 * How often the figures are re-read (#296). A balance changes with no action on
 * this page — an hourly charge, a cycle run, a top-up FinVault confirms — and a
 * stale balance is a wrong answer stated with confidence.
 */
export const POLL_MS = 15_000;

/** While a top-up is waiting on FinVault the person is watching for it to land. */
export const PENDING_POLL_MS = 3_000;

export function refreshInterval(ledger: LedgerEntry[]): number {
  return ledger.some((e) => e.type === 'topup' && e.status === 'pending') ? PENDING_POLL_MS : POLL_MS;
}

/** How a ledger status reads in the table (#298). */
export function statusLabel(status: LedgerEntry['status']): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'confirmed':
      return 'Confirmed';
    case 'failed':
      return 'Failed';
    case 'expired':
      return 'Not confirmed';
  }
}

/** Top-ups that were pending in `before` and are confirmed in `after`. */
export function newlyConfirmed(before: LedgerEntry[], after: LedgerEntry[]): LedgerEntry[] {
  // An expired top-up is still waiting in the sense that matters: FinVault may
  // confirm it late, and then the credit lands and deserves the same toast.
  const waiting = new Set(before.filter((e) => e.type === 'topup' && (e.status === 'pending' || e.status === 'expired')).map((e) => e.id));
  return after.filter((e) => waiting.has(e.id) && e.status === 'confirmed');
}

export function Billing() {
  const { toast } = useToast();
  const [wallet, setWallet] = useState<CreditWallet | null>(null);
  const [usage, setUsage] = useState<BillingUsage | null>(null);
  // How the plan charges (#297), said in words: "nothing was charged when I
  // created a server" reads as a bug unless the page says that is the model.
  const [charging, setCharging] = useState<ChargingModel | null>(null);
  useEffect(() => {
    let live = true;
    getEntitlements()
      .then((p) => live && setCharging(p.entitlements.charging))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState(10);
  const [busy, setBusy] = useState(false);
  // When the figures on screen were read, and whether the latest attempt to read
  // them again failed. A refresh that fails silently looks exactly like a stable
  // balance, which is the failure #296 is about.
  const [readAt, setReadAt] = useState<string | null>(null);
  const [staleReason, setStaleReason] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const ledgerRef = useRef<LedgerEntry[] | null>(null);

  const load = useCallback(async () => {
    try {
      const [w, u, l] = await Promise.all([getWallet(), getUsage(), getLedger()]);
      const landed = ledgerRef.current ? newlyConfirmed(ledgerRef.current, l) : [];
      ledgerRef.current = l;
      setWallet(w);
      setUsage(u);
      setLedger(l);
      setError(null);
      setStaleReason(null);
      setReadAt(new Date().toISOString());
      for (const e of landed) {
        toast(`${money(e.amount, e.currency)} credit has been added to your balance.`, 'success', 'Top-up confirmed');
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load billing';
      // Only the first read replaces the page: after that the last figures are
      // still the best we have, so they stay — marked as no longer current.
      if (ledgerRef.current) setStaleReason(message);
      else setError(message);
    }
  }, [toast]);

  // Re-read on a timer, faster while a top-up is pending. Each read schedules the
  // next from what it just read, so a top-up that turns pending speeds the page up
  // straight away. Paused while the tab is hidden (nobody is reading it) and
  // caught up the moment it is shown again.
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(true);
  const refresh = useCallback(async () => {
    clearTimeout(timerRef.current);
    if (typeof document === 'undefined' || !document.hidden) await load();
    // A read that finishes after the page is gone must not start another.
    if (!mountedRef.current) return;
    timerRef.current = setTimeout(() => void refresh(), refreshInterval(ledgerRef.current ?? []));
  }, [load]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mountedRef.current = false;
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  // Keeps "Updated 12s ago" honest between reads.
  useEffect(() => {
    const handle = setInterval(() => setTick((t) => t + 1), 5_000);
    return () => clearInterval(handle);
  }, []);

  const currency = wallet?.currency ?? usage?.plan.currency ?? 'EUR';

  const onTopUp = async () => {
    if (!(amount > 0)) return;
    setBusy(true);
    try {
      await topUp(amount);
      toast(`Top-up of ${money(amount, currency)} requested — credit is added once payment confirms.`, 'success', 'Top-up');
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Top-up failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="page"><p role="alert" className="alert alert--error">{error}</p></div>;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 24px 48px', animation: 'rise 300ms var(--ease-out) both' }}>
      <h1 style={{ marginBottom: 6 }}>Billing</h1>
      <p className="subtle" style={{ marginTop: 0, marginBottom: 12 }}>
        Prepaid credit funds your usage. Top up via FinVault; usage is charged at the end of each monthly cycle.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, fontSize: '.82rem' }}>
        <span className="subtle" aria-live="polite">
          {readAt ? `Updated ${formatRelative(readAt)}` : 'Loading…'}
        </span>
        <button className="btn btn--ghost btn--sm" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {staleReason && (
        <p role="alert" className="alert alert--error" style={{ marginTop: 0, marginBottom: 20 }}>
          Could not refresh ({staleReason}). The figures below are from {readAt ? formatRelative(readAt) : 'earlier'} and may be out of date.
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 22 }}>
        {/* Balance */}
        <div className="card" style={{ padding: '20px 22px' }}>
          <strong style={{ display: 'block', fontSize: '.82rem', color: 'var(--color-text-soft)', marginBottom: 4 }}>Credit balance</strong>
          <div style={{ fontSize: '1.9rem', fontWeight: 700, color: wallet && wallet.balance < 0 ? 'var(--color-danger)' : 'inherit' }}>
            {wallet ? money(wallet.balance, currency) : '—'}
          </div>
        </div>

        {/* This cycle */}
        <div className="card" style={{ padding: '20px 22px' }}>
          <strong style={{ display: 'block', fontSize: '.82rem', color: 'var(--color-text-soft)', marginBottom: 4 }}>This cycle</strong>
          <div style={{ fontSize: '1.9rem', fontWeight: 700 }}>{usage ? money(usage.cost, currency) : '—'}</div>
          <div className="subtle" style={{ fontSize: '.82rem' }}>{usage ? `${usage.hours.toFixed(1)} runtime hours` : ''}</div>
        </div>

        {/* Plan */}
        <div className="card" style={{ padding: '20px 22px' }}>
          <strong style={{ display: 'block', fontSize: '.82rem', color: 'var(--color-text-soft)', marginBottom: 4 }}>Plan</strong>
          <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{usage?.plan.name ?? '—'}</div>
          {usage && (
            <div className="subtle" style={{ fontSize: '.82rem' }}>
              {money(usage.plan.pricePerHour, currency)}/h · {usage.plan.freeHoursPerMonth}h free · {usage.plan.maxServers} servers
            </div>
          )}
        </div>
      </div>

      {charging && (
        <p className="subtle" style={{ fontSize: '.84rem', margin: '-8px 0 22px' }}>
          <strong style={{ color: 'var(--color-text-soft)' }}>How you are charged.</strong> {chargingSentence(charging)}
        </p>
      )}

      {/* Top up */}
      <div className="card" style={{ padding: '20px 22px', marginBottom: 22 }}>
        <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 10 }}>Top up credit</strong>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {TOP_UP_PRESETS.map((v) => (
            <button key={v} className={`btn btn--secondary btn--sm${amount === v ? ' is-active' : ''}`} data-ripple onClick={() => setAmount(v)}>
              {money(v, currency)}
            </button>
          ))}
          <input
            type="number"
            min={1}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            aria-label="Top-up amount"
            style={{ width: 100 }}
          />
          <button className="btn btn--primary btn--sm" data-ripple data-burst onClick={onTopUp} disabled={busy || !(amount > 0)}>
            {busy ? <span className="spinner" /> : `Top up ${money(amount || 0, currency)}`}
          </button>
        </div>
        <p className="subtle" style={{ margin: '10px 0 0', fontSize: '.8rem' }}>
          A top-up charges your FinVault wallet; credit lands here once the payment confirms.
        </p>
      </div>

      {/* History */}
      <div className="card" style={{ padding: '20px 22px' }}>
        <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 12 }}>Payment history</strong>
        {ledger.length === 0 ? (
          <div className="empty">No top-ups or charges yet.</div>
        ) : (
          <>
          {ledger.some((e) => e.type === 'topup' && e.status === 'expired') && (
            <p role="status" className="alert alert--warning" style={{ marginBottom: 12 }}>
              A top-up was not confirmed by FinVault in time, so no credit was added for it. If the payment did go through
              in FinVault, the credit is still added when FinVault confirms it. If it keeps happening, tell the operator
              of this panel — the two platforms may not be connected correctly.
            </p>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.86rem' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-text-soft)' }}>
                <th style={{ padding: '6px 8px' }}>When</th>
                <th style={{ padding: '6px 8px' }}>Type</th>
                <th style={{ padding: '6px 8px' }}>Description</th>
                <th style={{ padding: '6px 8px' }}>Status</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((e) => (
                <tr key={e.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '6px 8px' }}>{formatRelative(e.createdAt)}</td>
                  <td style={{ padding: '6px 8px', textTransform: 'capitalize' }}>{e.type}</td>
                  <td style={{ padding: '6px 8px' }}>{e.description}</td>
                  <td style={{ padding: '6px 8px' }}>{statusLabel(e.status)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: e.type === 'topup' ? 'var(--color-success)' : 'inherit' }}>
                    {e.type === 'topup' ? '+' : '−'}{money(e.amount, e.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </>
        )}
      </div>
    </div>
  );
}
