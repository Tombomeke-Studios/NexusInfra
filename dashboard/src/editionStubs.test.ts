import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDITION_STUBS, stubPattern } from '../editionStubs';

// The community build's aliases must catch every import of a hosted-only module
// (#393). Three of them used to name absolute paths, which an alias never sees,
// so they matched nothing and nobody noticed: the BILLING_INCLUDED gates were
// doing the work alone.

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(dashboard, 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every relative specifier imported or re-exported by the panel's own code. */
function relativeSpecifiers(): { file: string; specifier: string }[] {
  const found: { file: string; specifier: string }[] = [];
  const pattern = /(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const file of sourceFiles(src)) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) found.push({ file, specifier: match[1] });
  }
  return found;
}

describe('community build stub aliases (#393)', () => {
  it('names a real module and an existing stub for every entry', () => {
    for (const { module, real, stub } of EDITION_STUBS) {
      expect(existsSync(join(dashboard, real)), real).toBe(true);
      expect(existsSync(join(dashboard, stub)), stub).toBe(true);
      expect(basename(real).replace(/\.tsx?$/, '')).toBe(module);
    }
  });

  it('matches the specifiers as they are written', () => {
    expect(stubPattern('Billing').test('./pages/Billing')).toBe(true);
    expect(stubPattern('PlanPanel').test('../components/PlanPanel')).toBe(true);
    expect(stubPattern('suspension').test('../suspension')).toBe(true);
    expect(stubPattern('suspension').test('../../suspension.ts')).toBe(true);
  });

  it('leaves the stubs themselves and look-alike names alone', () => {
    expect(stubPattern('Billing').test('./pages/Billing.stub')).toBe(false);
    expect(stubPattern('Billing').test('./pages/BillingSummary')).toBe(false);
    expect(stubPattern('Billing').test('billing')).toBe(false);
    expect(stubPattern('suspension').test('react-suspension')).toBe(false);
  });

  it('is unambiguous: no other source file shares a stubbed module name', () => {
    const names = sourceFiles(src).map((f) => basename(f).replace(/\.tsx?$/, ''));
    for (const { module } of EDITION_STUBS) {
      expect(names.filter((n) => n === module), module).toHaveLength(1);
    }
  });

  it('catches every import of a stubbed module in the panel', () => {
    const imports = relativeSpecifiers();
    for (const { module, real } of EDITION_STUBS) {
      const target = join(dashboard, real).replace(/\.tsx?$/, '');
      const importers = imports.filter(({ file, specifier }) => resolve(dirname(file), specifier).replace(/\.tsx?$/, '') === target);
      expect(importers.length, `${module} is imported somewhere`).toBeGreaterThan(0);
      for (const { file, specifier } of importers) {
        expect(stubPattern(module).test(specifier), `${specifier} in ${file}`).toBe(true);
      }
    }
  });
});
