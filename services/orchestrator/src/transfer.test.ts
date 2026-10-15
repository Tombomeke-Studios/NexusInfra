import { describe, it, expect } from 'vitest';
import { planTransfer } from './transfer.js';

const OLD = { id: 'user-old', email: 'old@example.com' };
const NEW = { id: 'user-new', email: 'new@example.com' };

const plan = (overrides: Parameters<typeof planTransfer>[0]) => planTransfer(overrides);

describe('planTransfer', () => {
  it('moves the server and leaves the previous owner with nothing by default', () => {
    const result = plan({ currentOwner: OLD, newOwner: NEW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.newOwnerId).toBe(NEW.id);
    expect(result.plan.retainedShare).toBeNull();
    expect(result.plan.auditMessage).toContain('old@example.com');
    expect(result.plan.auditMessage).toContain('new@example.com');
    expect(result.plan.auditMessage).toContain('lost access');
  });

  it('keeps the previous owner on as a bound share when they retain a role', () => {
    const result = plan({ currentOwner: OLD, newOwner: NEW, retainRole: 'admin' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Bound to the account, not left pending: they demonstrably have one.
    expect(result.plan.retainedShare).toEqual({ email: OLD.email, userId: OLD.id, role: 'admin' });
    expect(result.plan.auditMessage).toContain('kept admin');
  });

  it('refuses to leave the previous owner as owner, however it is asked', () => {
    // The one role a share cannot confer. Stepping down is the only option.
    for (const role of ['owner', 'superuser', 42, {}]) {
      const result = plan({ currentOwner: OLD, newOwner: NEW, retainRole: role });
      expect(result).toMatchObject({ ok: false, status: 400 });
    }
  });

  it('treats an absent, null or empty retained role as walking away', () => {
    for (const role of [undefined, null, '']) {
      const result = plan({ currentOwner: OLD, newOwner: NEW, retainRole: role });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.plan.retainedShare).toBeNull();
    }
  });

  it('refuses a transfer to the account that already owns the server', () => {
    expect(plan({ currentOwner: OLD, newOwner: OLD })).toMatchObject({ ok: false, status: 400 });
  });

  it('drops a share the incoming owner already held', () => {
    // Otherwise the new owner shows up as a subuser of their own server, and
    // revoking that share would look like it should remove their access.
    const result = plan({ currentOwner: OLD, newOwner: NEW, existingShareForNewOwner: { id: 'share-1' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.dropShareId).toBe('share-1');
  });

  it('rescues a server whose owner account is gone', () => {
    // The orphan this feature exists for. Nothing to grant back, so asking for a
    // retained role is refused rather than quietly ignored.
    const rescue = plan({ currentOwner: null, newOwner: NEW });
    expect(rescue.ok).toBe(true);
    if (rescue.ok) expect(rescue.plan.newOwnerId).toBe(NEW.id);

    expect(plan({ currentOwner: null, newOwner: NEW, retainRole: 'viewer' })).toMatchObject({ ok: false, status: 409 });
  });
});
