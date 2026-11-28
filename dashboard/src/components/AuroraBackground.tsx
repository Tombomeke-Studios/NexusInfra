// Ambient animated background from the design: a drifting grid, an animated node
// network canvas (data-bg-net — drifting nodes that link up and stream packets),
// three blurred aurora blobs and an fx layer for click bursts. Nothing follows the
// cursor (#449). Purely decorative DOM; the motion is driven by fx.ts.
export function AuroraBackground() {
  return (
    <>
      <div aria-hidden className="bg-layer">
        <div className="bg-grid" />
        <canvas aria-hidden data-bg-net className="bg-net" />
        <div className="aurora aurora--1" />
        <div className="aurora aurora--2" />
        <div className="aurora aurora--3" />
      </div>
      <div id="fx-layer" aria-hidden className="fx-layer" />
    </>
  );
}
