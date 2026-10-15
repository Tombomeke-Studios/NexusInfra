// Memory budgeting (#271) — reconciling the two numbers that control the same
// physical RAM.
//
// A server has a container memory cap, expressed as a percentage of the node's
// total RAM, which the kernel enforces absolutely. A JVM game server *also* has a
// heap size, and `itzg/minecraft-server` passes it to both -Xms and -Xmx, so the
// JVM commits it: the memory is genuinely taken, not reserved-if-needed.
//
// Nothing used to relate them, and the defaults collided — a 2G heap inside a
// 2048 MB cap on a 4 GB machine. The JVM commits the heap, crosses the cap, and
// the kernel kills the container mid-save. The panel could only report "crashed",
// because from its side the container simply exited.
//
// Pure: capacities are passed in, so the arithmetic is tested without a host.

/** Thrown when a heap cannot fit the cap it has to live inside. */
export class MemoryBudgetError extends Error {}

/**
 * Parse a JVM-style memory string to whole MB: `2G`, `2048M`, `2048`, `1536m`.
 *
 * Returns null for anything it does not understand, so a caller can leave an
 * unparseable value alone rather than guess at it — an egg variable that is not a
 * memory size at all must not be silently treated as one.
 */
export function parseMemoryMb(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([gmk])?b?$/i.exec(String(value).trim());
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  switch ((match[2] ?? 'm').toLowerCase()) {
    case 'g':
      return Math.round(amount * 1024);
    case 'k':
      return Math.round(amount / 1024);
    default:
      return Math.round(amount);
  }
}

/**
 * The container's hard memory cap in MB, or null when it has none.
 *
 * `ramPercent` is a share of the node the server lands on, which is why this
 * needs the node: 50% means something different on a 4 GB box and a 64 GB one,
 * and telling somebody "50%" when they wanted to know "how many gigabytes" is
 * most of why the two settings drifted apart.
 */
export function containerMemoryMb(
  limits: { ramMb?: number; ramPercent?: number } | undefined,
  nodeTotalMb: number | null | undefined
): number | null {
  // An absolute cap needs no node at all, which is half of why it is the better
  // unit to set (#275).
  if (limits?.ramMb && limits.ramMb > 0) return Math.round(limits.ramMb);
  if (!limits?.ramPercent || limits.ramPercent <= 0) return null;
  if (!nodeTotalMb || nodeTotalMb <= 0) return null;
  return Math.round((limits.ramPercent / 100) * nodeTotalMb);
}

/**
 * How much the JVM needs *on top of* its heap: metaspace, thread stacks, code
 * cache, direct buffers, plus the container's own processes.
 *
 * A quarter of the heap with a 512 MB floor. Rough on purpose — the exact figure
 * depends on plugin count and thread pools, and the point is to refuse the
 * configurations that are certain to be killed rather than to predict usage.
 */
export function jvmOverheadMb(heapMb: number): number {
  return Math.max(512, Math.round(heapMb * 0.25));
}

export interface HeapCheck {
  heapMb: number;
  capMb: number;
}

/**
 * Explain why a heap does not fit its cap, or null when it does.
 *
 * Speaks in MB. `ramPercent` is the unit the setting is stored in and the worst
 * possible unit to be told about: "50% is not enough for a 2G heap" leaves you to
 * work out 50% of what.
 */
export function heapBudgetProblem({ heapMb, capMb }: HeapCheck): string | null {
  const overhead = jvmOverheadMb(heapMb);
  const needed = heapMb + overhead;
  if (needed <= capMb) return null;

  const preamble =
    `a ${heapMb} MB heap needs about ${needed} MB in total (the JVM uses roughly ${overhead} MB beyond the heap ` +
    `for metaspace, threads and buffers), but this server is capped at ${capMb} MB. `;

  // Below the usable floor there is no heap to suggest — "lower the heap to about
  // 0 MB" is arithmetic, not advice. The honest answer is that the cap is too
  // small to run a Java server at all.
  const largest = largestHeapForCap(capMb);
  if (largest < MIN_USABLE_HEAP_MB) {
    return `${preamble}A ${capMb} MB limit is too small for a Java server whatever the heap — raise the memory limit.`;
  }

  return `${preamble}Raise the memory limit or lower the heap to about ${largest} MB.`;
}

/**
 * The biggest heap that still leaves room for the JVM inside `capMb`.
 *
 * Inverts the overhead rule rather than guessing: below the floor's crossover the
 * binding constraint is the flat 512 MB, above it the 25% share.
 */
export function largestHeapForCap(capMb: number): number {
  // heap + max(512, heap/4) <= cap. Try the proportional branch first.
  const proportional = Math.floor((capMb * 4) / 5);
  if (jvmOverheadMb(proportional) > 512) return Math.max(0, proportional);
  return Math.max(0, capMb - 512);
}

/**
 * Below this there is no heap worth running a Java server on: the JVM's own
 * overhead has eaten the cap. Rounded to a number a person recognises rather than
 * derived, because the honest answer here is "give it more memory", not a heap.
 */
export const MIN_USABLE_HEAP_MB = 512;

/**
 * The heap to give a server, or **null** to leave the caller's own value alone.
 *
 * This is what stops the heap being a second setting for the same RAM (#308).
 * The container cap is the one number a person chooses; the heap is a
 * consequence of it, and asking for both is asking the same question twice in
 * two different units — one a percentage of a machine, the other an absolute
 * size — and then refusing the answer when they disagree.
 *
 * Returns null in the two cases where deriving would be a lie:
 *
 * - the caller set a heap themselves, so their number stands (and the budget
 *   check still refuses it if it does not fit);
 * - there is no cap to derive from, because the server is uncapped or the node
 *   has never reported how much memory it has. Inventing one would be #250 again.
 */
export function derivedHeapMb(capMb: number | null | undefined, explicit?: string | null): number | null {
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') return null;
  if (capMb == null || capMb <= 0) return null;

  const heap = largestHeapForCap(capMb);
  return heap >= MIN_USABLE_HEAP_MB ? heap : null;
}

/** A heap in the JVM-style string the egg's image expects (`-Xms`/`-Xmx`). */
export function formatHeapMb(heapMb: number): string {
  return `${heapMb}M`;
}
