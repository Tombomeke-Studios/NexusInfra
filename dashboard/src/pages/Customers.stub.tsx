// Stands in for the Customers page in a community build (#190, #369).
//
// The Vite config aliases the real page to this module when building the
// community edition, so none of the provider's billing UI reaches the bundle.
// Nothing should ever render it — the route is compiled out too.

export function Customers() {
  return (
    <section>
      <h1>Customers</h1>
      <p className="subtle">
        Plans and customer billing are part of the hosted edition. This panel is the community edition, which does not include them.
      </p>
    </section>
  );
}
