// The community build's stand-in for suspension.ts (#380): there is no billing,
// so nothing is ever suspended for lack of credit.

export function isSuspended(_d: unknown): boolean {
  void _d;
  return false;
}

export function suspensionNote(_d: unknown): string | null {
  void _d;
  return null;
}
