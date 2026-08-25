// Prove that a community bundle does not contain the hosted code (#190).
//
// Tree-shaking is easy to believe in and easy to get wrong: an accidental
// re-export or a dynamic reference silently pulls the module back in, and the
// only symptom is that a self-hosted panel ships code it can never run. So this
// checks the built output rather than trusting the configuration.
//
// Usage:  node scripts/verify-edition.mjs <community|hosted> [distDir]

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const edition = process.argv[2];
const dist = process.argv[3] ?? 'dist';

if (edition !== 'community' && edition !== 'hosted') {
  console.error('usage: node scripts/verify-edition.mjs <community|hosted> [distDir]');
  process.exit(2);
}

/** Strings that only the real billing page and its client produce. */
const BILLING_MARKERS = ['Credit balance', 'Top up via FinVault', '/billing/wallet', '/billing/topup', '/billing/ledger'];

/** Present in every build, so a bundle with none of these was not read properly. */
const CONTROL_MARKERS = ['New Deployment', 'Shared with me'];

function bundleFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...bundleFiles(full));
    else if (/\.(js|css)$/.test(entry)) out.push(full);
  }
  return out;
}

let files;
try {
  files = bundleFiles(dist);
} catch {
  console.error(`✖ no build found in ${dist}/ — run the build first`);
  process.exit(1);
}

const source = files.map((f) => readFileSync(f, 'utf8')).join('\n');

const missingControls = CONTROL_MARKERS.filter((m) => !source.includes(m));
if (missingControls.length) {
  // Guards against the check quietly passing because it read the wrong files.
  console.error(`✖ the bundle does not look like the dashboard (missing: ${missingControls.join(', ')})`);
  process.exit(1);
}

const found = BILLING_MARKERS.filter((m) => source.includes(m));

if (edition === 'community') {
  if (found.length) {
    console.error(`✖ community bundle still contains hosted code: ${found.join(', ')}`);
    console.error('  The billing module is reaching the bundle — check the alias in vite.config.ts.');
    process.exit(1);
  }
  console.log(`✔ community bundle contains no billing code (checked ${files.length} files, ${BILLING_MARKERS.length} markers)`);
} else {
  if (!found.length) {
    console.error('✖ hosted bundle is missing the billing code it is supposed to ship');
    process.exit(1);
  }
  console.log(`✔ hosted bundle contains the billing code (${found.length}/${BILLING_MARKERS.length} markers)`);
}
