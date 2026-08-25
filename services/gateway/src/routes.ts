// Pure routing table for the API Gateway (#20). The gateway is the single
// external entry point: it maps a request path prefix to an internal backend and
// records whether the route is public (auth-exempt). Keeping this a pure function
// means the routing rules are tested once, independently of the HTTP plumbing.

export interface RouteRule {
  /** Path prefix this rule matches (longest match wins). */
  prefix: string;
  /** Backend base URL to proxy to. */
  target: string;
  /** Public routes skip JWT validation (login, edition config, health). */
  public?: boolean;
}

export interface MatchedRoute {
  target: string;
  public: boolean;
}

// Backends. In the dev/compose stack the NexusInfra client API is served by the
// Orchestrator (which itself proxies /billing → Billing Bridge and /monitoring →
// Control Room), so the gateway fronts a single backend here; the table still
// distinguishes public vs protected paths.
export function defaultRoutes(orchestrator: string): RouteRule[] {
  return [
    { prefix: '/config', target: orchestrator, public: true },
    // Login and registration must be reachable without a token; the Orchestrator
    // decides whether registration is open for this edition (#174).
    { prefix: '/auth', target: orchestrator, public: true },
    { prefix: '/me', target: orchestrator },
    { prefix: '/users', target: orchestrator },
    { prefix: '/deployments', target: orchestrator },
    { prefix: '/nodes', target: orchestrator },
    { prefix: '/monitoring', target: orchestrator },
    { prefix: '/billing', target: orchestrator },
  ];
}

/** True when `path` equals the prefix or continues with a `/` (so `/nodes` ≠ `/nodesX`). */
export function prefixMatches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Resolve a request path to its backend + public flag; longest matching prefix wins. */
export function matchRoute(path: string, routes: RouteRule[]): MatchedRoute | null {
  let best: RouteRule | null = null;
  for (const rule of routes) {
    if (prefixMatches(path, rule.prefix) && (!best || rule.prefix.length > best.prefix.length)) {
      best = rule;
    }
  }
  return best ? { target: best.target, public: best.public === true } : null;
}
