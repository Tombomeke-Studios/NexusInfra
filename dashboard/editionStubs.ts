// The hosted-only modules a community build swaps for a stub (#190, #393).
//
// A Vite alias is matched against the import specifier **as written** — the
// `'./pages/Billing'` in `import { Billing } from './pages/Billing'` — before it
// is resolved to a file. An absolute path as `find` therefore never matches
// anything; until #393 three of these entries were exactly that, and only the
// `BILLING_INCLUDED` gates kept the real pages out of the bundle.
//
// So each entry names the module by its file name, and `stubPattern` matches any
// relative specifier that ends in it (`'./pages/Billing'`, `'../suspension'`).
// File names are unique in `src/`, which `editionStubs.test.ts` checks, together
// with every import of these modules being one the pattern catches.

export interface EditionStub {
  /** The module's file name without extension, as imports end in it. */
  module: string;
  /** The real module, relative to the dashboard directory. */
  real: string;
  /** Its stand-in, relative to the dashboard directory. */
  stub: string;
}

export const EDITION_STUBS: EditionStub[] = [
  { module: 'Billing', real: 'src/pages/Billing.tsx', stub: 'src/pages/Billing.stub.tsx' },
  // The provider's customers and plans (#369).
  { module: 'Customers', real: 'src/pages/Customers.tsx', stub: 'src/pages/Customers.stub.tsx' },
  // The plan panel in New Deployment (#297).
  { module: 'PlanPanel', real: 'src/components/PlanPanel.tsx', stub: 'src/components/PlanPanel.stub.tsx' },
  // A server billing suspended for lack of credit (#380).
  { module: 'suspension', real: 'src/suspension.ts', stub: 'src/suspension.stub.ts' },
];

/** Matches a relative import specifier that names `module`, with or without an extension. */
export function stubPattern(module: string): RegExp {
  return new RegExp(`^(?:\\.{1,2}/)+(?:[\\w.-]+/)*${module}(?:\\.tsx?)?$`);
}
