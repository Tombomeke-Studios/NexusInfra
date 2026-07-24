// Ambient animated background from the design: a drifting grid, three blurred
// aurora blobs, an fx layer (cursor trail / bursts), and the cursor-follow aura.
// Purely decorative DOM; the motion is driven by the interaction layer (fx.ts).
export function AuroraBackground() {
  return (
    <>
      <div aria-hidden className="bg-layer">
        <div className="bg-grid" />
        <div className="aurora aurora--1" />
        <div className="aurora aurora--2" />
        <div className="aurora aurora--3" />
      </div>
      <div id="fx-layer" aria-hidden className="fx-layer" />
      <div id="cursor-aura" aria-hidden className="cursor-aura" />
    </>
  );
}
