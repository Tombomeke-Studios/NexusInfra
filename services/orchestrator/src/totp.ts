// Two-factor authentication (#229).
//
// The panel hands out root shells inside containers and full control over the
// Docker hosts behind them. Until now a single password was the whole defence,
// and a password is the one credential people reuse.
//
// TOTP (RFC 6238) implemented here rather than pulled in: it is HMAC-SHA1 over a
// counter, Node already has the HMAC, and the whole thing fits in this file with
// the RFC's own test vectors as the check. A dependency for forty lines is a
// dependency to keep up to date in a security path.
//
// Pure: no clock of its own, no storage, no Express. `now` is always passed in.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** The interval every authenticator app assumes. Changing it breaks every enrolment. */
export const TOTP_STEP_SECONDS = 30;

/** Six digits, as every authenticator app expects. */
export const TOTP_DIGITS = 6;

/**
 * How many steps either side of now are accepted.
 *
 * One step, so a code stays usable for at most 90 seconds. Phones drift and
 * people type slowly; a window of zero rejects codes that were right when they
 * were read, which teaches people to distrust the feature.
 */
const DEFAULT_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 without padding — the encoding authenticator apps read. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh shared secret. 20 bytes is what RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code for one time step, per RFC 6238's dynamic truncation. */
export function totpCode(secret: string, counter: number): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBytes.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', base32Decode(secret)).update(counterBytes).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function counterFor(now: Date | number, stepSeconds = TOTP_STEP_SECONDS): number {
  const ms = typeof now === 'number' ? now : now.getTime();
  return Math.floor(ms / 1000 / stepSeconds);
}

/**
 * Whether `code` is valid for `secret` around `now`.
 *
 * Compared in constant time. The comparison leaks nothing useful on its own — the
 * code changes every thirty seconds — but a timing-variable compare in an
 * authentication path is a habit worth not having.
 */
export function verifyTotp(secret: string, code: string, now: Date | number, window = DEFAULT_WINDOW): boolean {
  const candidate = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(candidate)) return false;

  const base = counterFor(now);
  for (let offset = -window; offset <= window; offset += 1) {
    if (equalStrings(totpCode(secret, base + offset), candidate)) return true;
  }
  return false;
}

function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * Built here rather than in the browser so the secret has one representation:
 * the panel shows this string, and what the phone stores is what the server
 * stored.
 */
export function otpauthUrl(input: { issuer: string; account: string; secret: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── Recovery codes ──────────────────────────────────────────────────────────
//
// The answer to a lost phone. Without them, enabling 2FA on a self-hosted panel
// is a way to lock yourself out of your own machines permanently — there is no
// support desk to call, and in the community edition there may be no second
// administrator either.

export const RECOVERY_CODE_COUNT = 10;

/** Grouped for reading aloud and typing; the dash is stripped on the way in. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars, 40 bits
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * SHA-256, for the same reason API tokens use it: 40 bits of randomness in a
 * code that can only be tried against a rate-limited login, hashed on a path
 * where bcrypt would be a self-inflicted delay.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

/** Does this look like a recovery code rather than a six-digit TOTP code? */
export function looksLikeRecoveryCode(code: string): boolean {
  return /^[0-9A-F]{10}$/.test(normalizeRecoveryCode(code));
}
