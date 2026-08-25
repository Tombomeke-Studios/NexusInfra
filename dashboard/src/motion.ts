// Whether animations should run. False when the OS asks to reduce motion, and
// also false in non-browser/test environments (no matchMedia) so JS-driven
// animations render their final state deterministically.
export function motionEnabled(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
