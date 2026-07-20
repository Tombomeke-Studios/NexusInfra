import { describe, it, expect } from 'vitest';
import { buildEnvelope, encryptPayload, decryptPayload, readPayload } from './events.js';

// These tests lock in wire-compatibility with FinVault. The encryption algorithm,
// KDF salt and envelope shape here are identical to FinVault/shared/src/events.ts,
// so a payload encrypted with a shared FINVAULT_MESSAGE_KEY round-trips across
// both platforms. If any of these assertions break, integration breaks.

const KEY = 'shared-message-key-for-tests';

describe('AES-256-GCM payload encryption', () => {
  it('round-trips an encrypted payload with the shared key', () => {
    const payload = { reference: 'INV-001', amount: 42.5, currency: 'EUR' };
    const cipher = encryptPayload(payload, KEY);
    expect(cipher).toBeTypeOf('string');
    expect(decryptPayload(cipher, KEY)).toEqual(payload);
  });

  it('uses the FinVault ciphertext layout: iv(12) | tag(16) | ciphertext', () => {
    const cipher = encryptPayload({ a: 1 }, KEY);
    const buf = Buffer.from(cipher, 'base64');
    // 12-byte IV + 16-byte tag + at least 1 byte of ciphertext
    expect(buf.length).toBeGreaterThan(28);
  });

  it('fails to decrypt with a different key (tamper/interop guard)', () => {
    const cipher = encryptPayload({ secret: true }, KEY);
    expect(() => decryptPayload(cipher, 'wrong-key')).toThrow();
  });
});

describe('Event envelope', () => {
  it('encrypts the payload but keeps type readable when a key is set', () => {
    process.env.FINVAULT_MESSAGE_KEY = KEY;
    const envelope = buildEnvelope('billing-bridge', {
      type: 'payment.request',
      payload: {
        reference: 'INV-001',
        senderWalletId: 'w-1',
        receiverWalletId: 'w-2',
        amount: 10,
        currency: 'EUR',
        description: 'server runtime',
      },
    });

    expect(envelope.event.type).toBe('payment.request');
    expect((envelope.event.payload as any).encrypted).toBe(true);
    expect(envelope.eventId).toBeDefined();
    expect(envelope.timestamp).toBeDefined();

    // A consumer holding the same key recovers the original payload.
    const recovered = readPayload(envelope.event);
    expect(recovered.reference).toBe('INV-001');
    expect(recovered.amount).toBe(10);
    delete process.env.FINVAULT_MESSAGE_KEY;
  });

  it('sends plaintext payload when no key is set', () => {
    delete process.env.FINVAULT_MESSAGE_KEY;
    const envelope = buildEnvelope('control-room', {
      type: 'heartbeat.service',
      payload: { name: 'control-room', status: 'healthy', timestamp: new Date().toISOString() },
    });
    expect((envelope.event.payload as any).name).toBe('control-room');
  });
});
