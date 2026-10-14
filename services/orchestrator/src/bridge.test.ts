import { describe, it, expect, afterEach, vi } from 'vitest';
import { INTERNAL_TOKEN_HEADER, getInternalToken } from 'shared';
import { bridgeFetch, BILLING_BRIDGE_URL } from './bridge.js';

describe('bridgeFetch (#372)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('carries the internal token on every call, beside the caller’s own headers', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await bridgeFetch('/billing/u1/topup', { method: 'POST', headers: { 'content-type': 'application/json' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BILLING_BRIDGE_URL}/billing/u1/topup`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json', [INTERNAL_TOKEN_HEADER]: getInternalToken() });
  });
});
