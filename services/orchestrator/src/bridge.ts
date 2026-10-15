import { getInternalToken, INTERNAL_TOKEN_HEADER } from 'shared';

// The one way the Orchestrator calls the Billing Bridge (#372). The bridge
// trusts its caller for *which account* a request is about — the user id is in
// the path — so it accepts only callers holding the internal token, and every
// call has to carry it. A bare `fetch` to the bridge answers 401.

export const BILLING_BRIDGE_URL = process.env.BILLING_BRIDGE_URL || 'http://billing-bridge:9300';

/** `fetch` against the Billing Bridge, with the internal token attached. `path` starts with a slash. */
export function bridgeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BILLING_BRIDGE_URL}${path}`, {
    ...init,
    headers: { ...((init.headers as Record<string, string> | undefined) ?? {}), [INTERNAL_TOKEN_HEADER]: getInternalToken() },
  });
}
