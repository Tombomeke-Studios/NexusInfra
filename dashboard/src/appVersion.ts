// Which release this bundle is, and whether the server has moved on (#447).
//
// A browser keeps the panel it loaded for as long as the tab stays open. After an
// update the server speaks the new release and the page is still the old one —
// buttons for routes that changed, no buttons for the new features — and nothing
// said so. The server's version comes from GET /config; this compares the two.

declare const __APP_VERSION__: string;

export const DEV_VERSION = '0.0.0-dev';

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : DEV_VERSION;

/**
 * True when the server runs a different release than this bundle. A dev build
 * on either side is never "stale": versions there mean nothing.
 */
export function isStaleBundle(bundleVersion: string, serverVersion: string | null | undefined): boolean {
  if (!serverVersion || bundleVersion === DEV_VERSION || serverVersion === DEV_VERSION) return false;
  return bundleVersion !== serverVersion;
}
