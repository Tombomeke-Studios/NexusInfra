import { useEffect, useRef } from 'react';
import { motionEnabled } from '../motion';

// Ambient animated background from the design: a drifting grid, three blurred
// aurora blobs, and a soft glow that follows the cursor. Purely decorative
// (aria-hidden); the cursor glow only tracks the pointer when motion is enabled.
export function AuroraBackground() {
  const auraRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!motionEnabled()) return;
    const el = auraRef.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      el.style.opacity = '1';
      el.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    };
    const onLeave = () => {
      el.style.opacity = '0';
    };
    window.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  return (
    <>
      <div aria-hidden className="bg-layer">
        <div className="bg-grid" />
        <div className="aurora aurora--1" />
        <div className="aurora aurora--2" />
        <div className="aurora aurora--3" />
      </div>
      <div ref={auraRef} aria-hidden className="cursor-aura" />
    </>
  );
}
