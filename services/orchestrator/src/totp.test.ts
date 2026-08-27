import { describe, it, expect } from 'vitest';
import {
  base32Decode,
  base32Encode,
  counterFor,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  normalizeRecoveryCode,
  otpauthUrl,
  totpCode,
  TOTP_STEP_SECONDS,
  verifyTotp,
} from './totp.js';

// RFC 6238's own vectors, with the SHA-1 seed "12345678901234567890". They are
// the reason this is implemented here rather than pulled in: an implementation
// that reproduces the standard's numbers is one that any authenticator app will
// agree with.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (const input of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'hello world']) {
      expect(base32Decode(base32Encode(Buffer.from(input))).toString()).toBe(input);
    }
  });

  it('matches the known encoding of the RFC seed', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('ignores spacing and case, as people typing a secret would', () => {
    expect(base32Decode('gezd gnbv').toString()).toBe(base32Decode('GEZDGNBV').toString());
  });

  it('refuses input that is not base32', () => {
    expect(() => base32Decode('not-base32!')).toThrow();
  });
});

describe('totpCode', () => {
  // Time → expected 6-digit code, straight from RFC 6238 appendix B (SHA-1).
  const vectors: Array<[number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];

  it.each(vectors)('matches RFC 6238 at t=%i', (seconds, expected) => {
    expect(totpCode(RFC_SECRET, counterFor(seconds * 1000))).toBe(expected);
  });

  it('changes every 30 seconds and not between', () => {
    const at = (s: number) => totpCode(RFC_SECRET, counterFor(s * 1000));
    expect(at(0)).toBe(at(TOTP_STEP_SECONDS - 1));
    expect(at(0)).not.toBe(at(TOTP_STEP_SECONDS));
  });
});

describe('verifyTotp', () => {
  const now = 1111111111 * 1000;

  it('accepts the current code', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, counterFor(now)), now)).toBe(true);
  });

  it('accepts one step either side, for a phone that drifts', () => {
    const base = counterFor(now);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, base - 1), now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, base + 1), now)).toBe(true);
  });

  it('refuses anything further out', () => {
    const base = counterFor(now);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, base - 2), now)).toBe(false);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, base + 2), now)).toBe(false);
  });

  it('tolerates the spaces authenticator apps display', () => {
    const code = totpCode(RFC_SECRET, counterFor(now));
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(true);
  });

  it('refuses anything that is not six digits, without consulting the secret', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12345a']) {
      expect(verifyTotp(RFC_SECRET, bad, now)).toBe(false);
    }
  });

  it('refuses a code from a different secret', () => {
    const other = generateTotpSecret();
    expect(verifyTotp(RFC_SECRET, totpCode(other, counterFor(now)), now)).toBe(false);
  });
});

describe('otpauthUrl', () => {
  it('carries everything an app needs to agree with us', () => {
    const url = otpauthUrl({ issuer: 'NexusInfra', account: 'ada@example.com', secret: RFC_SECRET });
    expect(url.startsWith('otpauth://totp/NexusInfra:ada%40example.com?')).toBe(true);
    expect(url).toContain(`secret=${RFC_SECRET}`);
    expect(url).toContain('algorithm=SHA1');
    expect(url).toContain('digits=6');
    expect(url).toContain('period=30');
  });
});

describe('recovery codes', () => {
  it('mints ten distinct codes by default', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  it('accepts a code however it was typed back', () => {
    const [code] = generateRecoveryCodes(1);
    const hash = hashRecoveryCode(code);
    expect(hashRecoveryCode(code.toLowerCase())).toBe(hash);
    expect(hashRecoveryCode(code.replace('-', ''))).toBe(hash);
    expect(hashRecoveryCode(` ${code} `)).toBe(hash);
  });

  it('tells a recovery code apart from a six-digit TOTP code', () => {
    // The login route has one field for both, so this is what decides which
    // check runs.
    for (const code of generateRecoveryCodes(5)) expect(looksLikeRecoveryCode(code)).toBe(true);
    expect(looksLikeRecoveryCode('123456')).toBe(false);
    expect(normalizeRecoveryCode('ab-cd')).toBe('ABCD');
  });
});
