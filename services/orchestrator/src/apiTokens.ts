// API tokens for scripts and CI (#228).
//
// Everything required a JWT obtained by password login, so automating anything
// against the panel meant putting a person's password in a script — a credential
// that opens the whole account, cannot be told apart from that person in a log,
// and cannot be withdrawn without locking them out too.
//
// This module is the pure half: how a token is minted, recognised, hashed and
// scoped. The storage and the middleware live elsewhere.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Marks a bearer token as ours rather than a JWT, so the two are told apart by
 * shape instead of by trying to verify one as the other. Also makes a leaked
 * token greppable — secret scanners key on prefixes like this.
 */
export const API_TOKEN_PREFIX = 'nxi_';

/** 32 bytes of randomness, base64url. Guessing is not a threat model. */
const SECRET_BYTES = 32;

export function isApiTokenSecret(value: string): boolean {
  return value.startsWith(API_TOKEN_PREFIX) && value.length > API_TOKEN_PREFIX.length;
}

/**
 * SHA-256, not bcrypt.
 *
 * A password is low-entropy and typed by a human, so it needs a slow hash to
 * survive an offline attack. This secret is 256 random bits: there is nothing to
 * brute-force, and the hash runs on every authenticated request, where bcrypt's
 * work factor would be a self-inflicted rate limit.
 */
export function hashApiToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time digest comparison, for callers that compare rather than look up. */
export function tokenHashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Mint a token. The secret is returned once and never stored. */
export function generateApiToken(): { secret: string; hash: string } {
  const secret = API_TOKEN_PREFIX + randomBytes(SECRET_BYTES).toString('base64url');
  return { secret, hash: hashApiToken(secret) };
}

// ── Scopes ──────────────────────────────────────────────────────────────────
//
// Scoping is done by *method*, not by a table of paths.
//
// A path table is a second description of the API that has to be kept in step
// with the first, and the day it falls behind is the day a new route is
// unscoped — silently, and only for the callers who use tokens. Safe methods
// are already the line the HTTP spec draws, every route is on one side of it,
// and a route added tomorrow is covered without anyone remembering to add it.
//
// A scope only ever *narrows*. A token can never do something its account
// cannot: per-server roles are resolved exactly as they are for a person.

export const API_SCOPES = ['write', 'admin'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === 'string' && (API_SCOPES as readonly string[]).includes(value);
}

/** Parse the stored space-separated form, dropping anything unrecognised. */
export function parseScopes(stored: string | null | undefined): ApiScope[] {
  return (stored ?? '').split(/\s+/).filter(isApiScope);
}

export function formatScopes(scopes: readonly ApiScope[]): string {
  return [...new Set(scopes)].join(' ');
}

/** Methods that only read. Everything else changes something. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Whether a token holding `scopes` may issue this request.
 *
 * Read access is implied — a token that can do nothing at all would be a row
 * with no purpose. Anything that changes state needs `write`.
 */
export function scopeAllowsMethod(scopes: readonly ApiScope[], method: string): boolean {
  return isSafeMethod(method) || scopes.includes('write');
}

/** Whether a token may act on the panel's administrative routes at all. */
export function scopeAllowsAdmin(scopes: readonly ApiScope[]): boolean {
  return scopes.includes('admin');
}

/** A token past its expiry is dead without anyone having to delete the row. */
export function isExpired(expiresAt: string | null | undefined, now: Date = new Date()): boolean {
  return expiresAt ? new Date(expiresAt).getTime() <= now.getTime() : false;
}
