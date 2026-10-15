/**
 * Memory helpers mirrored from the orchestrator (#271).
 *
 * A mirror, like `permissions.ts`: the API is what refuses an impossible heap.
 * This exists so the clash is visible while you are setting it, rather than as a
 * container the kernel kills later. Keep the two in step.
 */

/** Parse a JVM-style memory string to whole MB: `2G`, `2048M`, `2048`. */
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

/** What the JVM needs beyond its heap: a quarter of it, with a 512 MB floor. */
export function jvmOverheadMb(heapMb: number): number {
  return Math.max(512, Math.round(heapMb * 0.25));
}

/**
 * The biggest heap that still leaves the JVM its overhead inside `capMb`.
 * Mirrors `largestHeapForCap` in the orchestrator.
 */
export function largestHeapForCap(capMb: number): number {
  const proportional = Math.floor((capMb * 4) / 5);
  if (jvmOverheadMb(proportional) > 512) return Math.max(0, proportional);
  return Math.max(0, capMb - 512);
}

/** Below this the JVM's own overhead has eaten the cap; there is no heap to offer. */
export const MIN_USABLE_HEAP_MB = 512;

/**
 * The heap the API will derive from a cap, or null when it will not derive one
 * (#308) — mirrored so the number is visible while the slider moves, rather than
 * only once the server exists. The API is what actually decides.
 */
export function derivedHeapMb(capMb: number | null | undefined, explicit?: string | null): number | null {
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') return null;
  if (capMb == null || capMb <= 0) return null;
  const heap = largestHeapForCap(capMb);
  return heap >= MIN_USABLE_HEAP_MB ? heap : null;
}

/** A heap in the JVM-style string the egg's image expects. */
export function formatHeapMb(heapMb: number): string {
  return `${heapMb}M`;
}
