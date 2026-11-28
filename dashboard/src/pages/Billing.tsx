import { useCallback, useEffect, useRef, useState } from 'react';
import { getWallet, getUsage, getLedger, getStanding, topUp, getEntitlements, getCurrentUser, requestEmailVerification, type CreditWallet, type BillingUsage, type CreditStanding, type LedgerEntry, type ChargingModel } from '../api';
import { chargingSentence } from '../plan';
import { useToast } from '../components/Toast';
import { PlanChooser } from '../components/PlanChooser';
import { useEdition } from '../edition';
import { formatRelative } from '../format';
import QRCode from 'qrcode';
import { topUpEpcPayload, type Payee } from '../topUpQr';

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
/** What to do next after asking for a top-up: the credit only arrives once it is approved in FinVault (#351). */
export function approvalHint(amount: string, payerEmail?: string | null): string {
  if (payerEmail === null) return `Scan the QR code below with the FinVault app to pay ${amount}. The credit is added here as soon as you approve it.`;
  const where = payerEmail ? `the FinVault account of ${payerEmail}` : 'your FinVault account';
  return `A payment request for ${amount} is waiting in ${where}. Approve it there and the credit is added here.`;
}

/**
 * What a waiting top-up asks of the customer (#435). It names the address: the
 * request only appears in a FinVault account with exactly that one, and
 * "waiting for you" with nothing waiting was the whole bug. With a QR (#436) the
 * address stops mattering — whoever scans it pays it.
 */
export function pendingTopUpNote(payerEmail: string | null | undefined, canScan: boolean): string {
  // Scan-only (#445): nothing waits in any inbox, so there is no address to name.
  if (payerEmail === null) return 'Open the FinVault app, scan this QR code and approve the payment to add the credit.';
  const where = payerEmail ? `the FinVault account of ${payerEmail}` : 'your FinVault account';
  const first = `A top-up is waiting in ${where}, under Invoices → Payment Requests. Pay it there to add the credit, or decline it to cancel.`;
  if (canScan) return `${first} No FinVault account with that address? Scan the QR code with the FinVault app instead — it pays the same request.`;
  return `${first} It appears only in a FinVault account with exactly that address.`;
}

/** The EPC QR for one waiting top-up (#436), or nothing when it cannot be paid by scanning. */
function TopUpQrCode({ entry, payee }: { entry: LedgerEntry; payee: Payee | null }) {
  const payload = topUpEpcPayload(payee, entry.amount, entry.reference);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!payload) return;
    let live = true;
    QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 176 })
      .then((url) => live && setSrc(url))
      .catch(() => undefined); // no QR beats a broken one; the request is still payable in FinVault
    return () => {
      live = false;
    };
  }, [payload]);
  if (!payload) return null;
  return (
    <figure style={{ margin: '12px 0 0', display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
      {src ? (
        <img src={src} width={176} height={176} alt={`QR code: pay ${money(entry.amount, entry.currency)} with the FinVault app`} style={{ borderRadius: 8, background: '#fff' }} />
      ) : (
        <div style={{ width: 176, height: 176 }} aria-hidden="true" />
      )}
      <figcaption style={{ fontSize: '.85rem', maxWidth: 280 }}>
        Scan with the FinVault app to pay <strong>{money(entry.amount, entry.currency)}</strong>. Reference{' '}
        <code style={{ wordBreak: 'break-all' }}>{entry.reference}</code>
      </figcaption>
    </figure>
  );
}

/** The line under "Left to spend": where the figure comes from. */
export function leftToSpendNote(standing: CreditStanding): string {
  const parts = [`balance less ${money(standing.accrued, standing.currency)} used this cycle`];
  if (standing.freeHoursLeft > 0) parts.push(`${standing.freeHoursLeft.toFixed(1)} free hours left`);
  return parts.join(' · ');
}

/** "about 21 hours", "about 3 days" — mirrors `runwayText` in the orchestrator's credit.ts (#379). */
function runwayText(hours: number): string {
  if (hours < 1) return 'less than an hour';
  if (hours < 48) {
    const h = Math.round(hours);
    return `about ${h} hour${h === 1 ? '' : 's'}`;
  }
  return `about ${Math.round(hours / 24)} days`;
}

/**
 * What "left to spend" means in time (#379), or null when the bridge does not
 * say. Nothing running means nothing is being spent — not that it lasts forever.
 */
export function runwayNote(standing: CreditStanding): string | null {
  if (standing.hoursLeft === undefined) return null;
  if (standing.hoursLeft === null) return 'No server is running, so nothing is being spent';
  return `Lasts ${runwayText(standing.hoursLeft)} at the current rate`;
}

/** A reason from another system, shown as a sentence. */
export function sentence(reason: string): string {
  const text = reason.trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? '' : '.');
}

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
  // What is left once this cycle's usage so far is taken off (#365). The balance
  // alone overstates it: usage is only charged to it when the month closes.
  const [standing, setStanding] = useState<CreditStanding | null>(null);
  // How the plan charges (#297), said in words: "nothing was charged when I
  // created a server" reads as a bug unless the page says that is the model.
  const [charging, setCharging] = useState<ChargingModel | null>(null);
  // A top-up's payment request goes to the FinVault account with this address,
  // so it has to be confirmed first — where the installation can confirm at all (#367).
  const { emailVerification, finvault } = useEdition();
  const [me, setMe] = useState<{ email: string; emailVerified?: boolean } | null>(null);
  const [linkState, setLinkState] = useState<'idle' | 'sending' | 'sent'>('idle');
  useEffect(() => {
    let live = true;
    getCurrentUser()
      .then((u) => live && setMe(u))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const mustConfirm = emailVerification && me !== null && me.emailVerified === false;
  const sendLink = async () => {
    setLinkState('sending');
    try {
      const result = await requestEmailVerification();
      if (result.status === 'verified') {
        // Confirmed in another tab since this page loaded.
        setMe((current) => (current ? { ...current, emailVerified: true } : current));
        setLinkState('idle');
      } else {
        setLinkState('sent');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not send the mail', 'error');
      setLinkState('idle');
    }
  };

  // Bumped when the plan changes (#369): the sentence describes the plan, and one
  // left describing the plan you just moved off is a wrong price stated plainly.
  const [planVersion, setPlanVersion] = useState(0);
  useEffect(() => {
    let live = true;
    getEntitlements()
      .then((p) => live && setCharging(p.entitlements.charging))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [planVersion]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState(10);
  // How this top-up is paid (#445). The address a FinVault account is under
  // need not be the one this panel knows, so it can be typed — or left out
  // altogether by paying with the QR code.
  const [payWith, setPayWith] = useState<'email' | 'qr'>('email');
  const [finvaultEmail, setFinvaultEmail] = useState<string | null>(null);
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
      const [w, u, l, s] = await Promise.all([getWallet(), getUsage(), getLedger(), getStanding().catch(() => null)]);
      setStanding(s && typeof s.canRun === 'boolean' ? s : null);
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

  const canScan = Boolean(finvault?.payee);
  // Prefilled with the address the last top-up went to, else the account's own.
  const lastPayer = ledger.find((e) => e.type === 'topup' && e.payerEmail)?.payerEmail ?? null;
  const payerField = finvaultEmail ?? lastPayer ?? me?.email ?? '';
  const payerValid = payerField.trim() === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerField.trim());
  const byQr = payWith === 'qr' && canScan;
  // The confirmation (#367) guards an address sent to FinVault; a QR sends none.
  const blocked = !byQr && (mustConfirm || !payerValid);

  const onTopUp = async () => {
    if (!(amount > 0) || blocked) return;
    setBusy(true);
    try {
      const typed = payerField.trim().toLowerCase();
      const payer = byQr ? ({ payWith: 'qr' } as const) : typed && typed !== me?.email?.toLowerCase() ? { finvaultEmail: typed } : {};
      const { payerEmail } = await topUp(amount, payer);
      toast(approvalHint(money(amount, currency), payerEmail), 'success', 'Top-up requested');
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
        Prepaid credit funds your usage. Top up via FinVault; usage is charged at the end of each monthly cycle, and
        servers stop when the credit runs out before then.
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

        {/* What is left */}
        {standing && (
          <div className="card" style={{ padding: '20px 22px' }}>
            <strong style={{ display: 'block', fontSize: '.82rem', color: 'var(--color-text-soft)', marginBottom: 4 }}>Left to spend</strong>
            <div style={{ fontSize: '1.9rem', fontWeight: 700, color: standing.available < 0 ? 'var(--color-danger)' : 'inherit' }}>
              {money(standing.available, standing.currency)}
            </div>
            <div className="subtle" style={{ fontSize: '.82rem' }}>{leftToSpendNote(standing)}</div>
            {runwayNote(standing) && (
              <div style={{ fontSize: '.82rem', marginTop: 4, fontWeight: standing.runsLow ? 600 : 400 }}>{runwayNote(standing)}</div>
            )}
          </div>
        )}

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

      {/* #379: said before it happens, not only once the servers have stopped. */}
      {standing?.canRun && standing.runsLow && typeof standing.hoursLeft === 'number' && (
        <p role="status" className="alert alert--warning" style={{ marginTop: 0, marginBottom: 22 }}>
          Your credit runs out in {runwayText(standing.hoursLeft)} at the rate your servers are using it. Top up below, or your running servers will be stopped
          when it does.
        </p>
      )}

      {standing && !standing.canRun && (
        <p role="alert" className="alert alert--error" style={{ marginTop: 0, marginBottom: 22 }}>
          {standing.available < 0
            ? `You owe ${money(-standing.available, standing.currency)} for what your servers have already used.`
            : 'You have no credit left.'}{' '}
          Servers cannot be started, and running ones are stopped, until you top up.
        </p>
      )}

      {charging && (
        <p className="subtle" style={{ fontSize: '.84rem', margin: '-8px 0 22px' }}>
          <strong style={{ color: 'var(--color-text-soft)' }}>How you are charged.</strong> {chargingSentence(charging)}
        </p>
      )}

      {/* A different plan changes the rate and the limits shown above. */}
      <PlanChooser
        onChanged={() => {
          setPlanVersion((v) => v + 1);
          void refresh();
        }}
      />

      {/* Top up */}
      <div className="card" style={{ padding: '20px 22px', marginBottom: 22 }}>
        <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 10 }}>Top up credit</strong>
        <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
          <legend className="subtle" style={{ fontSize: '.82rem', marginBottom: 6 }}>Pay with</legend>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <input type="radio" name="payWith" value="email" checked={!byQr} onChange={() => setPayWith('email')} />
            A payment request in my FinVault account
          </label>
          {!byQr && (
            <div style={{ margin: '0 0 8px 26px' }}>
              <label htmlFor="finvault-email" style={{ display: 'block', fontSize: '.8rem', marginBottom: 4 }}>
                The email address you sign in to FinVault with
              </label>
              <input
                id="finvault-email"
                type="email"
                autoComplete="email"
                value={payerField}
                onChange={(e) => setFinvaultEmail(e.target.value)}
                aria-invalid={!payerValid}
                style={{ width: 'min(100%, 320px)' }}
              />
              {!payerValid && (
                <span role="alert" className="field__hint" style={{ display: 'block', marginTop: 4, color: 'var(--color-danger)' }}>
                  That is not an email address.
                </span>
              )}
            </div>
          )}
          {canScan && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="radio" name="payWith" value="qr" checked={byQr} onChange={() => setPayWith('qr')} />
              A QR code I scan with the FinVault app
            </label>
          )}
        </fieldset>
        {mustConfirm && !byQr && (
          <div role="status" className="alert alert--warning" style={{ marginBottom: 12 }}>
            <strong>Confirm your email address first.</strong> A top-up sends a payment request to a FinVault account, so we need to
            know <span className="mono">{me?.email}</span> is yours{canScan ? ' — or pay with a QR code, which sends no request' : ''}. Open the link we mailed you
            {linkState === 'sent' ? ' — a new one is on its way.' : ', or '}
            {linkState !== 'sent' && (
              <button className="btn btn--secondary btn--sm" onClick={() => void sendLink()} disabled={linkState === 'sending'} style={{ marginLeft: 4 }}>
                {linkState === 'sending' ? 'Sending…' : 'send it again'}
              </button>
            )}
          </div>
        )}
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
          <button className="btn btn--primary btn--sm" data-ripple data-burst onClick={onTopUp} disabled={busy || !(amount > 0) || blocked}>
            {busy ? <span className="spinner" /> : `Top up ${money(amount || 0, currency)}`}
          </button>
        </div>
        <p className="subtle" style={{ margin: '10px 0 0', fontSize: '.8rem' }}>
          {byQr ? (
            <>A QR code appears below. Scan it with the FinVault app and approve — from any FinVault account — and the credit lands here within seconds.</>
          ) : (
            <>
              The request appears in the FinVault account with {payerField.trim() ? <strong>{payerField.trim().toLowerCase()}</strong> : 'your email address'}, under
              Invoices → Payment Requests. Approve it there and the credit lands here within seconds.
            </>
          )}{' '}
          Nothing is charged until you approve.
          {finvault?.url && (
            <>
              {' '}
              <a href={finvault.url} target="_blank" rel="noopener noreferrer">Open FinVault</a>
            </>
          )}
        </p>
        {ledger.some((e) => e.type === 'topup' && e.status === 'pending') && (
          <div role="status" className="alert alert--warning" style={{ margin: '12px 0 0' }}>
            {ledger
              .filter((e) => e.type === 'topup' && e.status === 'pending')
              .map((e, i) => (
                <div key={e.id} style={{ marginTop: i === 0 ? 0 : 16 }}>
                  {/* Each top-up says where it went: one may be to an address, the next a QR (#445). */}
                  <p style={{ margin: 0 }}>{pendingTopUpNote(e.payerEmail === undefined ? me?.email : e.payerEmail, canScan)}</p>
                  <TopUpQrCode entry={e} payee={finvault?.payee ?? null} />
                </div>
              ))}
          </div>
        )}
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
                  <td style={{ padding: '6px 8px' }}>
                    {statusLabel(e.status)}
                    {e.status === 'failed' && e.failureReason && (
                      <div className="subtle" style={{ fontSize: '.78rem' }}>{sentence(e.failureReason)}</div>
                    )}
                  </td>
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
