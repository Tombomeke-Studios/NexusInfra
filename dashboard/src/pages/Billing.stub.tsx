// Stands in for the billing page in a community build (#190).
//
// The Vite config aliases the real page to this module when building the
// community edition, so none of the billing UI reaches the bundle. Nothing
// should ever render it — the route is compiled out too — but it exists so the
// import resolves and so a mistake surfaces as a clear message rather than a
// blank screen.

export function Billing() {
  return (
    <section>
      <h1>Billing</h1>
      <p className="subtle">
        Billing is part of the hosted edition. This panel is the community edition, which does not include it.
      </p>
    </section>
  );
}
