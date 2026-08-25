// Which edition this bundle was **built** for (#190).
//
// `__BUILD_EDITION__` is replaced with a literal at build time (see
// vite.config.ts), so `BILLING_INCLUDED` is a compile-time constant. That is
// what lets the bundler drop the billing route and, with the module alias in the
// Vite config, leave the billing page out of the community bundle altogether.
//
// This is deliberately *not* the same thing as `useEdition()`, which asks the
// running Orchestrator what edition it is. Both exist and they answer different
// questions:
//
//   BILLING_INCLUDED — "is this code even in the bundle?"  (build time, static)
//   useEdition()     — "is the server I'm talking to hosted?" (runtime)
//
// A community bundle can never show billing because the code is not there; a
// hosted bundle still asks the server before showing it.

declare const __BUILD_EDITION__: string;

export const BUILD_EDITION: 'community' | 'hosted' = __BUILD_EDITION__ === 'hosted' ? 'hosted' : 'community';

/** True only in a hosted build, where the billing UI is actually present. */
export const BILLING_INCLUDED: boolean = BUILD_EDITION === 'hosted';
