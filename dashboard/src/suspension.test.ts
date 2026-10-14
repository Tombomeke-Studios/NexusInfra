import { describe, it, expect } from 'vitest';
import { isSuspended, suspensionNote } from './suspension';

// #380: a server billing stopped must not look like one its owner stopped.

const stopped = { status: 'stopped' as const, suspendedAt: '2026-10-15T00:00:00.000Z', suspendedReason: 'credit exhausted' };

describe('isSuspended', () => {
  it('is a server billing stopped and nobody has started since', () => {
    expect(isSuspended(stopped)).toBe(true);
    expect(isSuspended({ ...stopped, status: 'crashed' })).toBe(true);
  });

  it('is not a server that never was, or one on its way back up', () => {
    expect(isSuspended({ status: 'stopped', suspendedAt: null })).toBe(false);
    expect(isSuspended({ status: 'stopped' })).toBe(false);
    expect(isSuspended({ ...stopped, status: 'running' })).toBe(false);
    expect(isSuspended({ ...stopped, status: 'pending' })).toBe(false);
  });
});

describe('suspensionNote', () => {
  it('tells the owner what to do about it', () => {
    expect(suspensionNote({ ...stopped, role: 'owner' })).toBe(
      'Stopped by billing because your account ran out of credit (credit exhausted). Top up on the Billing page, then start it again.'
    );
    // No role means the caller's own server.
    expect(suspensionNote(stopped)).toContain('your account ran out of credit');
  });

  it('tells someone it is shared with whose credit it was', () => {
    expect(suspensionNote({ ...stopped, role: 'operator' })).toBe(
      "Stopped by billing because its owner's account ran out of credit (credit exhausted). It can be started again once they top up."
    );
  });

  it('says nothing about a server that is not suspended', () => {
    expect(suspensionNote({ ...stopped, status: 'running' })).toBeNull();
  });
});
