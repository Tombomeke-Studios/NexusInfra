import { useCallback, useEffect, useState } from 'react';
import {
  createNotificationChannel,
  deleteNotificationChannel,
  getNotificationSettings,
  testNotificationChannel,
  updateNotificationChannel,
  NOTIFICATION_EVENT_LABELS,
  type NotificationEventName,
  type NotificationSettings,
} from '../api';
import { InfoHint } from './InfoHint';
import { useToast } from './Toast';
import { useDialog } from './Dialog';
import { formatRelative } from '../format';

/**
 * Where this account hears about crashes, suspensions and — for administrators —
 * nodes going offline (#236). A server that crashed at 3am used to be found by
 * whoever next opened the panel.
 */
export function NotificationsCard() {
  const { toast } = useToast();
  const { confirm } = useDialog();
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [kind, setKind] = useState<'webhook' | 'email'>('webhook');
  const [target, setTarget] = useState('');
  const [format, setFormat] = useState<'json' | 'discord' | 'slack'>('json');
  const [events, setEvents] = useState<NotificationEventName[]>(['server.crashed']);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await getNotificationSettings();
      // An orchestrator without notifications answers something else; show
      // nothing rather than a card that cannot work.
      setSettings(Array.isArray(s?.channels) && Array.isArray(s?.capabilities?.events) ? s : null);
    } catch {
      setSettings(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!settings) return null;

  const toggleEvent = (e: NotificationEventName) => setEvents((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));

  const add = async () => {
    setBusy(true);
    try {
      const made = await createNotificationChannel({ kind, events, ...(kind === 'webhook' ? { target: target.trim(), format } : {}) });
      setSecret(made.secret ?? null);
      setTarget('');
      toast(kind === 'webhook' ? 'Webhook added' : 'Email notifications on', 'success', 'Notifications');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add the channel', 'error', 'Notifications');
    } finally {
      setBusy(false);
    }
  };

  const test = async (id: string) => {
    const r = await testNotificationChannel(id).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : 'failed' }));
    toast(r.ok ? 'Test sent — check that it arrived' : `Test failed: ${r.error}`, r.ok ? 'success' : 'error', 'Notifications');
    await load();
  };

  const remove = async (id: string, label: string) => {
    const ok = await confirm({ title: `Remove ${label}?`, message: 'Nothing more is sent there, including anything still waiting to be retried.', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    await deleteNotificationChannel(id);
    await load();
  };

  return (
    <div className="card" style={{ padding: 24, marginBottom: 18 }}>
      <strong style={{ display: 'block', fontSize: '.95rem', marginBottom: 6 }}>
        Notifications
        <InfoHint
          text="Hear about a crash when it happens rather than the next time you open the panel. Webhooks are signed (X-NexusInfra-Signature, HMAC-SHA256 of the body) and retried with backoff for about a day if the receiver is down."
          label="Notifications help"
        />
      </strong>
      <p className="subtle" style={{ margin: '0 0 16px', fontSize: '.84rem' }}>
        For every server you can access. {settings.capabilities.email ? '' : 'Email is not configured on this installation.'}
      </p>

      {settings.channels.map((c) => {
        const label = c.kind === 'email' ? `email to ${c.target}` : c.target;
        return (
          <div key={c.id} style={{ borderTop: '1px solid var(--color-border)', padding: '12px 0', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div className="mono" style={{ fontSize: '.82rem', wordBreak: 'break-all' }}>
                {label}
                {c.kind === 'webhook' && c.format !== 'json' && <span className="subtle"> · {c.format}</span>}
              </div>
              <div className="subtle" style={{ fontSize: '.76rem', marginTop: 3 }}>
                {c.events.map((e) => NOTIFICATION_EVENT_LABELS[e] ?? e).join(' · ')}
                {' — '}
                {c.lastError ? (
                  <span style={{ color: 'var(--color-danger)' }}>last attempt failed: {c.lastError}</span>
                ) : c.lastDeliveryAt ? (
                  `last delivered ${formatRelative(c.lastDeliveryAt)}`
                ) : (
                  'nothing sent yet'
                )}
              </div>
            </div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '.82rem' }}>
              <input type="checkbox" checked={c.enabled} onChange={(e) => void updateNotificationChannel(c.id, { enabled: e.target.checked }).then(load)} aria-label={`Send to ${label}`} />
              On
            </label>
            <button className="btn btn--secondary btn--sm" onClick={() => void test(c.id)}>Test</button>
            <button className="btn btn--ghost btn--sm" onClick={() => void remove(c.id, label)} aria-label={`Remove ${label}`}>Remove</button>
          </div>
        );
      })}

      {secret && (
        <p role="status" className="alert" style={{ margin: '12px 0', fontSize: '.82rem' }}>
          Signing secret — shown once, keep it with the receiver: <code className="mono" style={{ wordBreak: 'break-all' }}>{secret}</code>
        </p>
      )}

      <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 14, marginTop: settings.channels.length ? 4 : 0 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as 'webhook' | 'email')} aria-label="Channel kind" style={{ width: 'auto' }}>
            <option value="webhook">Webhook</option>
            {settings.capabilities.email && <option value="email">Email to me</option>}
          </select>
          {kind === 'webhook' && (
            <>
              <input className="input" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://…" aria-label="Webhook URL" style={{ flex: 1, minWidth: 200 }} />
              <select className="select" value={format} onChange={(e) => setFormat(e.target.value as 'json' | 'discord' | 'slack')} aria-label="Webhook format" style={{ width: 'auto' }}>
                <option value="json">JSON</option>
                <option value="discord">Discord</option>
                <option value="slack">Slack</option>
              </select>
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 12, fontSize: '.84rem' }}>
          {settings.capabilities.events.map((e) => (
            <label key={e} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={events.includes(e)} onChange={() => toggleEvent(e)} />
              {NOTIFICATION_EVENT_LABELS[e]}
            </label>
          ))}
        </div>
        <button className="btn btn--primary btn--sm" data-ripple disabled={busy || !events.length || (kind === 'webhook' && !target.trim())} onClick={() => void add()}>
          Add
        </button>
      </div>
    </div>
  );
}
