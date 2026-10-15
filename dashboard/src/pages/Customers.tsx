import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  adminAdjustCredit,
  adminCreatePlan,
  adminListAccounts,
  adminListPlans,
  adminSetAccountPlan,
  adminUpdatePlan,
  ApiError,
  type BillingAccount,
  type BillingPlanOption,
} from '../api';
import { EMPTY_PLAN_FORM, formToPlan, hourly, money, parseAdjustment, planToForm, type PlanForm } from '../billingAdmin';
import { useToast } from '../components/Toast';

// Customers (#369) — the provider's side of the hosted edition: who has an
// account, what they are on, what they have and what they have used; and the
// plans they choose between.
//
// Before this the provider had no view of their own business. A plan was a row
// seeded at first start, and "how much has this customer paid" meant opening
// the database.
//
// The nav hides this page from non-administrators; that is cosmetic. The API
// answers 403 regardless, which is the real gate. Hosted only — a community
// build replaces this module with a stub.

const cell = { padding: '8px 10px' } as const;

// Wide tables scroll inside their card. `position: relative` makes the card the
// containing block for anything absolutely positioned in it — without it such an
// element escapes the card's clipping and the whole page scrolls sideways.
const tableCard = { padding: 0, overflowX: 'auto', position: 'relative' } as const;

export function Customers() {
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<BillingAccount[] | null>(null);
  const [plans, setPlans] = useState<BillingPlanOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, p] = await Promise.all([adminListAccounts(), adminListPlans()]);
      setAccounts(a);
      setPlans(p);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiError && e.status === 403 ? 'Only platform administrators can see customers and plans.' : e instanceof Error ? e.message : 'Could not load customers');
      setAccounts((current) => current ?? []);
    }
  }, []);
  useEffect(() => void load(), [load]);

  // ── Adjusting one account's credit ────────────────────────────────────────
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openAdjust = (userId: string) => {
    setAdjusting((current) => (current === userId ? null : userId));
    setAmount('');
    setReason('');
    setAdjustError(null);
  };

  const submitAdjust = async (e: FormEvent, account: BillingAccount) => {
    e.preventDefault();
    const parsed = parseAdjustment(amount, reason);
    if (!parsed.ok) return setAdjustError(parsed.error);
    setBusy(true);
    try {
      await adminAdjustCredit(account.userId, parsed.amount, parsed.reason);
      toast(`${money(Math.abs(parsed.amount), account.currency)} ${parsed.amount > 0 ? 'added to' : 'removed from'} ${account.email}.`, 'success', 'Credit adjusted');
      setAdjusting(null);
      await load();
    } catch (err) {
      setAdjustError(err instanceof Error ? err.message : 'Could not adjust the credit');
    } finally {
      setBusy(false);
    }
  };

  const movePlan = async (account: BillingAccount, planId: string) => {
    if (planId === account.planId) return;
    try {
      await adminSetAccountPlan(account.userId, planId);
      toast(`${account.email} is now on ${plans.find((p) => p.id === planId)?.name ?? planId}.`, 'success', 'Plan changed');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change the plan', 'error');
    }
    await load();
  };

  // ── The plan form: a new plan, or one being edited ────────────────────────
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<PlanForm>(EMPTY_PLAN_FORM);
  const [planError, setPlanError] = useState<string | null>(null);
  const set = (key: keyof PlanForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const openPlan = (plan: BillingPlanOption | null) => {
    setEditing(plan ? plan.id : 'new');
    setForm(plan ? planToForm(plan) : EMPTY_PLAN_FORM);
    setPlanError(null);
  };

  const submitPlan = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = formToPlan(form);
    if (!parsed.ok) return setPlanError(parsed.error);
    setBusy(true);
    try {
      if (editing === 'new') await adminCreatePlan(parsed.body);
      else if (editing) await adminUpdatePlan(editing, parsed.body);
      toast(editing === 'new' ? `${parsed.body.name} is now on offer.` : `${parsed.body.name} was updated.`, 'success', 'Plans');
      setEditing(null);
      await load();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Could not save the plan');
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (plan: BillingPlanOption, active: boolean) => {
    try {
      await adminUpdatePlan(plan.id, { active });
      toast(active ? `${plan.name} is on offer again.` : `${plan.name} is retired: nobody new can choose it.`, 'success', 'Plans');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change the plan', 'error');
    }
    await load();
  };

  const offered = plans.filter((p) => p.active);
  const totals = (accounts ?? []).reduce((sum, a) => ({ balance: sum.balance + a.balance, cost: sum.cost + a.cost, running: sum.running + a.runningServers }), { balance: 0, cost: 0, running: 0 });
  const currency = accounts?.[0]?.currency ?? plans[0]?.currency ?? 'EUR';

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 24px 48px', animation: 'rise 300ms var(--ease-out) both' }}>
      <h1 style={{ marginBottom: 6 }}>Customers</h1>
      <p className="subtle" style={{ marginTop: 0, marginBottom: 20 }}>
        Everyone with an account here, what they are on and what they have used this month — and the plans they choose between.
      </p>

      {loadError && <p role="alert" className="alert alert--error" style={{ marginBottom: 16 }}>{loadError}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 22 }}>
        <Figure label="Accounts" value={String(accounts?.length ?? '—')} />
        <Figure label="Servers running now" value={String(totals.running)} />
        <Figure label="Used this month" value={money(totals.cost, currency)} note="charged when the month closes" />
        <Figure label="Credit held" value={money(totals.balance, currency)} note="prepaid and not yet spent" />
      </div>

      <div className="card" style={{ ...tableCard, marginBottom: 28 }}>
        {accounts === null ? (
          <div className="empty">Loading…</div>
        ) : accounts.length === 0 ? (
          <div className="empty">No accounts to show.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.86rem' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-text-soft)' }}>
                <th style={cell}>Account</th>
                <th style={cell}>Plan</th>
                <th style={{ ...cell, textAlign: 'right' }}>Servers</th>
                <th style={{ ...cell, textAlign: 'right' }}>Used this month</th>
                <th style={{ ...cell, textAlign: 'right' }}>Balance</th>
                <th style={{ ...cell, textAlign: 'right' }}>Left to spend</th>
                <th style={cell} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <AccountRows
                  key={a.userId}
                  account={a}
                  plans={plans}
                  onPlan={(planId) => void movePlan(a, planId)}
                  adjusting={adjusting === a.userId}
                  onAdjust={() => openAdjust(a.userId)}
                >
                  <form onSubmit={(e) => void submitAdjust(e, a)} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <div>
                      <label className="field__label" htmlFor={`amount-${a.userId}`}>Amount ({a.currency})</label>
                      <input id={`amount-${a.userId}`} className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25 or -5" style={{ width: 130 }} autoFocus />
                    </div>
                    <div style={{ flex: 1, minWidth: 220 }}>
                      <label className="field__label" htmlFor={`reason-${a.userId}`}>Reason — the customer sees this</label>
                      <input id={`reason-${a.userId}`} className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Refund for the outage on the 3rd" maxLength={200} />
                    </div>
                    <button type="submit" className="btn btn--primary btn--sm" data-ripple disabled={busy}>
                      {busy ? <span className="spinner" /> : 'Apply'}
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAdjusting(null)}>Cancel</button>
                    {adjustError && <p role="alert" className="alert alert--error" style={{ flexBasis: '100%', margin: 0 }}>{adjustError}</p>}
                  </form>
                </AccountRows>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Plans</h2>
        <button className="btn btn--secondary btn--sm" data-ripple onClick={() => openPlan(null)}>New plan</button>
      </div>
      <p className="subtle" style={{ marginTop: 0, marginBottom: 14, fontSize: '.84rem' }}>
        {offered.length} on offer. A price change applies to the whole month in progress for everyone on the plan, because usage is charged when the month closes —
        to change a price cleanly, add a new plan and retire the old one. Retiring keeps the accounts a plan has and stops anyone new choosing it.
      </p>

      {editing && (
        <div className="card" style={{ padding: 22, marginBottom: 16 }}>
          <strong style={{ display: 'block', fontSize: '.95rem', marginBottom: 14 }}>{editing === 'new' ? 'New plan' : `Edit ${plans.find((p) => p.id === editing)?.name ?? 'plan'}`}</strong>
          <form onSubmit={(e) => void submitPlan(e)}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0 16px' }}>
              <PlanField id="plan-name" label="Name" value={form.name} onChange={set('name')} placeholder="Pro" />
              <PlanField id="plan-price" label={`Price per server-hour (${currency})`} value={form.pricePerHour} onChange={set('pricePerHour')} placeholder="0.05" hint="For a server at half a node's CPU and memory; bigger ones cost proportionally more." decimal />
              <PlanField id="plan-free" label="Free hours each month" value={form.freeHoursPerMonth} onChange={set('freeHoursPerMonth')} placeholder="0" hint="Zero means a customer has to top up before running anything." decimal />
              <PlanField id="plan-servers" label="Servers" value={form.maxServers} onChange={set('maxServers')} placeholder="5" />
              <PlanField id="plan-databases" label="Databases" value={form.maxDatabases} onChange={set('maxDatabases')} placeholder="5" />
              <PlanField id="plan-ram" label="Memory across all servers (GB)" value={form.maxRamGb} onChange={set('maxRamGb')} placeholder="No ceiling" decimal />
              <PlanField id="plan-backups" label="Backups kept per server" value={form.maxBackupsPerServer} onChange={set('maxBackupsPerServer')} placeholder="No ceiling" />
            </div>
            {planError && <p role="alert" className="alert alert--error" style={{ marginBottom: 14 }}>{planError}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" className="btn btn--primary" data-ripple disabled={busy}>
                {busy ? <span className="spinner" /> : editing === 'new' ? 'Add plan' : 'Save changes'}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="card" style={tableCard}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.86rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--color-text-soft)' }}>
              <th style={cell}>Plan</th>
              <th style={{ ...cell, textAlign: 'right' }}>Per server-hour</th>
              <th style={{ ...cell, textAlign: 'right' }}>Free hours</th>
              <th style={{ ...cell, textAlign: 'right' }}>Servers</th>
              <th style={{ ...cell, textAlign: 'right' }}>Databases</th>
              <th style={{ ...cell, textAlign: 'right' }}>Memory</th>
              <th style={{ ...cell, textAlign: 'right' }}>Accounts</th>
              <th style={cell} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td style={cell}>
                  <strong>{p.name}</strong> {!p.active && <span className="badge badge--neutral">Retired</span>}
                </td>
                <td style={{ ...cell, textAlign: 'right' }}>{hourly(p.pricePerHour, p.currency)}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{p.freeHoursPerMonth}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{p.maxServers}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{p.maxDatabases}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{p.maxRamMb == null ? '—' : `${Number((p.maxRamMb / 1024).toFixed(1))} GB`}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{(accounts ?? []).filter((a) => a.planId === p.id).length}</td>
                <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn btn--ghost btn--sm" onClick={() => openPlan(p)} aria-label={`Edit the ${p.name} plan`}>Edit</button>{' '}
                  <button className="btn btn--ghost btn--sm" onClick={() => void setActive(p, !p.active)} aria-label={p.active ? `Retire the ${p.name} plan` : `Offer the ${p.name} plan again`}>
                    {p.active ? 'Retire' : 'Offer again'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card" style={{ padding: '18px 20px' }}>
      <strong style={{ display: 'block', fontSize: '.82rem', color: 'var(--color-text-soft)', marginBottom: 4 }}>{label}</strong>
      <div style={{ fontSize: '1.6rem', fontWeight: 700 }}>{value}</div>
      {note && <div className="subtle" style={{ fontSize: '.8rem' }}>{note}</div>}
    </div>
  );
}

function PlanField(props: { id: string; label: string; value: string; onChange: (e: { target: { value: string } }) => void; placeholder?: string; hint?: string; decimal?: boolean }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={props.id}>{props.label}</label>
      <input id={props.id} className="input" value={props.value} onChange={props.onChange} placeholder={props.placeholder} inputMode={props.decimal ? 'decimal' : undefined} />
      {props.hint && <span className="subtle" style={{ display: 'block', marginTop: 6, fontSize: '.78rem' }}>{props.hint}</span>}
    </div>
  );
}

function AccountRows(props: {
  account: BillingAccount;
  plans: BillingPlanOption[];
  onPlan: (planId: string) => void;
  adjusting: boolean;
  onAdjust: () => void;
  children: React.ReactNode;
}) {
  const a = props.account;
  // The plans on offer, plus this account's own if it has been retired.
  const choices = props.plans.filter((p) => p.active || p.id === a.planId);
  return (
    <>
      <tr style={{ borderTop: '1px solid var(--color-border)' }}>
        <td style={cell}>
          <strong style={{ display: 'block' }}>{a.displayName}</strong>
          <span className="mono subtle" style={{ fontSize: '.8rem', wordBreak: 'break-all' }}>{a.email}</span>
          {a.platformRole !== 'user' && <span className="badge badge--info" style={{ marginLeft: 6, textTransform: 'capitalize' }}>{a.platformRole}</span>}
        </td>
        <td style={cell}>
          <select className="select" value={a.planId ?? ''} onChange={(e) => props.onPlan(e.target.value)} aria-label={`Plan for ${a.email}`} style={{ minWidth: 130 }}>
            {choices.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (retired)'}</option>
            ))}
          </select>
        </td>
        <td style={{ ...cell, textAlign: 'right' }}>
          {a.servers}
          {a.runningServers > 0 && <span className="subtle"> · {a.runningServers} running</span>}
        </td>
        <td style={{ ...cell, textAlign: 'right' }}>
          {money(a.cost, a.currency)}
          <span className="subtle" style={{ display: 'block', fontSize: '.78rem' }}>{a.hours.toFixed(1)} h</span>
        </td>
        <td style={{ ...cell, textAlign: 'right' }}>{money(a.balance, a.currency)}</td>
        <td style={{ ...cell, textAlign: 'right', color: a.available < 0 ? 'var(--color-danger)' : 'inherit' }}>
          {money(a.available, a.currency)}
          {a.canRun === false && <span className="badge badge--warning" style={{ marginLeft: 6 }}>Cannot run</span>}
        </td>
        <td style={{ ...cell, textAlign: 'right' }}>
          <button className="btn btn--secondary btn--sm" data-ripple onClick={props.onAdjust} aria-expanded={props.adjusting} aria-label={`Adjust credit for ${a.email}`}>
            Adjust credit
          </button>
        </td>
      </tr>
      {props.adjusting && (
        <tr>
          <td colSpan={7} style={{ padding: '4px 10px 16px', background: 'var(--color-surface-2, transparent)' }}>{props.children}</td>
        </tr>
      )}
    </>
  );
}
