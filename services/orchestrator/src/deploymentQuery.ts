// Searching, filtering and paging the server list (#237).
//
// The list rendered every deployment the caller could see, all at once. Fine
// with five servers; unusable with two hundred, and it grows without bound as
// people keep using the panel.
//
// Pure: query parameters in, a filter and a page in, a page of rows out. The
// route does the visibility resolution (which is per-caller) and then hands the
// rows here.
//
// One limitation, stated rather than papered over: the rows are filtered *after*
// the repository has read them, so this bounds what crosses the wire and what
// the browser renders, not what the database scans. That is the half that
// actually hurts today — the panel was rendering hundreds of live-polling rows —
// and pushing the predicate into Prisma is a change to the repository interface
// that should happen when a single installation has enough servers to notice.

/** A row this module can filter. Matches DeploymentView structurally. */
export interface FilterableDeployment {
  id: string;
  name: string;
  status: string;
  nodeId: string | null;
  userId: string;
  createdAt: string;
}

export interface DeploymentFilter {
  /** Case-insensitive substring of the name. */
  q?: string;
  /** Exact status, e.g. `running`. */
  status?: string;
  /** Exact node id, or the string `unassigned` for rows with no node. */
  nodeId?: string;
  /** Exact owner account id. */
  ownerId?: string;
}

export interface PageRequest {
  limit: number;
  offset: number;
}

/** What the route answers with. `total` is the count *after* filtering. */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;

/** Rows with no node at all, addressable as a filter value. */
export const UNASSIGNED = 'unassigned';

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Read a filter out of a query string.
 *
 * Anything unrecognised is simply absent, never an error: a stale bookmark with
 * a filter we have since dropped should still show the person their servers.
 */
export function parseFilter(query: Record<string, unknown>): DeploymentFilter {
  return {
    q: text(query.q),
    status: text(query.status),
    nodeId: text(query.nodeId),
    ownerId: text(query.ownerId),
  };
}

/**
 * Read the page out of a query string, clamped.
 *
 * A limit is applied whether or not one was asked for — an unbounded list is
 * what this exists to prevent — and capped, so `?limit=100000` cannot be used to
 * ask the panel to render everything after all.
 */
export function parsePage(query: Record<string, unknown>): PageRequest {
  const asInt = (value: unknown, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  return {
    limit: Math.min(Math.max(asInt(query.limit, DEFAULT_LIMIT), 1), MAX_LIMIT),
    offset: asInt(query.offset, 0),
  };
}

export function matchesFilter(row: FilterableDeployment, filter: DeploymentFilter): boolean {
  if (filter.q && !row.name.toLowerCase().includes(filter.q.toLowerCase())) return false;
  if (filter.status && row.status !== filter.status) return false;
  if (filter.nodeId) {
    const wanted = filter.nodeId === UNASSIGNED ? null : filter.nodeId;
    if (row.nodeId !== wanted) return false;
  }
  if (filter.ownerId && row.userId !== filter.ownerId) return false;
  return true;
}

/**
 * Filter, sort and cut one page.
 *
 * Newest first, and ties broken by id: without a total order, two rows created
 * in the same millisecond can swap places between requests, which shows one of
 * them twice across a page boundary and hides the other entirely.
 */
export function pageOf<T extends FilterableDeployment>(rows: T[], filter: DeploymentFilter, page: PageRequest): Page<T> {
  const matched = rows
    .filter((row) => matchesFilter(row, filter))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));

  return {
    items: matched.slice(page.offset, page.offset + page.limit),
    total: matched.length,
    limit: page.limit,
    offset: page.offset,
  };
}
