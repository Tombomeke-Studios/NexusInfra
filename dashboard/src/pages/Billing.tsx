import { useCallback, useEffect, useState } from 'react';
import { getWallet, getUsage, getLedger, topUp, type CreditWallet, type BillingUsage, type LedgerEntry } from '../api';
import { useToast } from '../components/Toast';
import { formatRelative } from '../format';

// Billing page (#149) — hosted edition only (the route is gated in routes.tsx via
// useEdition). Shows the credit balance, a top-up form (funded via FinVault), the
// usage/cost breakdown for the current cycle, and the payment history.

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
}

const TOP_UP_PRESETS = [5, 10, 25, 50];

export function Billing() {
  const { toast } = useToast();
  const [wallet, setWallet] = useState<CreditWallet | null>(null);
  const [usage, setUsage] = useState<BillingUsage | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState(10);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [w, u, l] = await Promise.all([getWallet(), getUsage(), getLedger()]);
      setWallet(w);
      setUsage(u);
      setLedger(l);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load billing');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const currency = wallet?.currency ?? usage?.plan.currency ?? 'EUR';

  const onTopUp = async () => {
    if (!(amount > 0)) return;
    setBusy(true);
    try {
      await topUp(amount);
      toast(`Top-up of ${money(amount, currency)} requested — credit is added once payment confirms.`, 'success', 'Top-up');
      await load();
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
      <p className="subtle" style={{ marginTop: 0, marginBottom: 24 }}>
        Prepaid credit funds your usage. Top up via FinVault; usage is charged at the end of each monthly cycle.
      </p>

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
                  <td style={{ padding: '6px 8px', textTransform: 'capitalize' }}>{e.status}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: e.type === 'topup' ? 'var(--color-success)' : 'inherit' }}>
                    {e.type === 'topup' ? '+' : '−'}{money(e.amount, e.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
