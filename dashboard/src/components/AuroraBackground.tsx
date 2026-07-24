// Ambient animated background from the design: a drifting grid, an animated node
// network canvas (data-bg-net — drifting nodes that link up, stream packets and
// react to the cursor), three blurred aurora blobs, an fx layer (cursor trail /
// bursts), and the cursor-follow aura. Purely decorative DOM; the motion is driven
// by the interaction layer (fx.ts).
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
      <div id="cursor-aura" aria-hidden className="cursor-aura" />
    </>
  );
}
