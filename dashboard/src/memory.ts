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
