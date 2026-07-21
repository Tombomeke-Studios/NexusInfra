import { useEffect, useState } from 'react';
import { motionEnabled } from '../motion';

// Animates a number from 0 to `value` with an ease-out curve. When motion is
// disabled (reduced-motion or tests) it renders the final value immediately.
export function CountUp({ value, duration = 650 }: { value: number; duration?: number }) {
  const [display, setDisplay] = useState(motionEnabled() ? 0 : value);

  useEffect(() => {
    if (!motionEnabled()) {
      setDisplay(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(Math.round(value * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return <>{display}</>;
}
