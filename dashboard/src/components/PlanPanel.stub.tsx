// Stands in for the plan panel in a community build (#297, #190): the Vite
// config aliases the real component to this one, so no plan or pricing code
// reaches that bundle. It renders nothing — the community edition has no plan.

export function PlanPanel(_props: { requestedRamMb: number | null; onUseRamMb?: (mb: number) => void }) {
  return null;
}
