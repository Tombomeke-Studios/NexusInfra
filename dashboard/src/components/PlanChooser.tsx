import { useCallback, useEffect, useState } from 'react';
import { choosePlan, getPlanOptions, type PlanOptions } from '../api';
import { hourly, planLimits } from '../billingAdmin';
import { useToast } from './Toast';
import { useDialog } from './Dialog';

// The plans a customer can choose between (#369), on the Billing page. There
// used to be one plan and no way to see, let alone change, what you were on.
//
// A plan the account does not fit is shown with the reason and no button: the
// server would refuse the switch anyway, and a button that answers "no" teaches
// nothing about what to do first.
//
// Hosted only — imported by the Billing page, which a community build replaces.

export function PlanChooser({ onChanged }: { onChanged?: () => void }) {
  const { toast } = useToast();
  const { confirm } = useDialog();
  const [options, setOptions] = useState<PlanOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOptions(await getPlanOptions());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the plans');
    }
  }, []);
  useEffect(() => void load(), [load]);

  if (error) return <p role="alert" className="alert alert--error" style={{ marginBottom: 22 }}>Plans could not be loaded ({error}).</p>;
  // One plan is not a choice; the card above already names it.
  if (!options?.plans || options.plans.length < 2) return null;

  const pick = async (planId: string, name: string) => {
    const ok = await confirm({
      title: `Switch to ${name}?`,
      message: 'What your servers have used so far this month stays at your current rate. From now on they are charged at the new one, and the new limits apply.',
      confirmLabel: `Switch to ${name}`,
    });
    if (!ok) return;
    setBusyId(planId);
    try {
      await choosePlan(planId);
      toast(`You are now on the ${name} plan.`, 'success', 'Plan changed');
      await load();
      onChanged?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change the plan', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section aria-labelledby="plans-heading" style={{ marginBottom: 22 }}>
      <strong id="plans-heading" style={{ display: 'block', fontSize: '.92rem', marginBottom: 10 }}>Plans</strong>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
        {options.plans.map((plan) => {
          const current = plan.id === options.currentPlanId;
          return (
            <div key={plan.id} className="card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 8, borderColor: current ? 'var(--color-primary)' : undefined }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                <strong style={{ fontSize: '1.05rem' }}>{plan.name}</strong>
                {current && <span className="badge badge--info">Your plan</span>}
              </div>
              <div>
                <span style={{ fontSize: '1.3rem', fontWeight: 700 }}>{hourly(plan.pricePerHour, plan.currency)}</span>
                <span className="subtle" style={{ fontSize: '.82rem' }}> per server-hour</span>
              </div>
              <ul className="subtle" style={{ margin: 0, paddingLeft: 18, fontSize: '.84rem', flex: 1 }}>
                {planLimits(plan).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {!current && !plan.active && <p className="subtle" style={{ margin: 0, fontSize: '.8rem' }}>No longer offered.</p>}
              {current && !plan.active && (
                <p className="subtle" style={{ margin: 0, fontSize: '.8rem' }}>This plan is no longer offered. You keep it until you switch; you cannot switch back.</p>
              )}
              {!current && plan.problem && (
                <p className="subtle" style={{ margin: 0, fontSize: '.8rem' }}>
                  <strong style={{ color: 'var(--color-text-soft)' }}>Does not fit yet:</strong> {plan.problem}.
                </p>
              )}
              {!current && !plan.problem && plan.active && (
                <button className="btn btn--secondary btn--sm" data-ripple disabled={busyId !== null} onClick={() => void pick(plan.id, plan.name)}>
                  {busyId === plan.id ? <span className="spinner" /> : `Switch to ${plan.name}`}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
