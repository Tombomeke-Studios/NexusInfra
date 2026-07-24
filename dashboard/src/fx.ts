import { motionEnabled } from './motion';

// Interaction layer from the design: click ripples on [data-ripple], particle
// bursts on [data-burst], cursor spotlight on [data-spotlight], and magnetic
// pull on [data-magnetic]. Delegated at the document level so it covers elements
// added/removed by React. Inert when motion is reduced.
export function initInteractionFx(): () => void {
  if (!motionEnabled()) return () => {};

  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const ripple = t.closest?.('[data-ripple]') as HTMLElement | null;
    if (ripple) spawnRipple(ripple, e);
    const burst = t.closest?.('[data-burst]') as HTMLElement | null;
    if (burst) spawnBurst(e.clientX, e.clientY, burst.getAttribute('data-burst') || 'primary');
  };

  let raf = 0;
  let lastSpot: HTMLElement | null = null;
  const onMove = (e: MouseEvent) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const spot = (e.target as HTMLElement).closest?.('[data-spotlight]') as HTMLElement | null;
      if (lastSpot && lastSpot !== spot) lastSpot.style.setProperty('--spot', '0');
      if (spot) {
        const r = spot.getBoundingClientRect();
        spot.style.setProperty('--mx', `${e.clientX - r.left}px`);
        spot.style.setProperty('--my', `${e.clientY - r.top}px`);
        spot.style.setProperty('--spot', '1');
      }
      lastSpot = spot;

      for (const m of Array.from(document.querySelectorAll<HTMLElement>('[data-magnetic]'))) {
        const r = m.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        if (Math.hypot(dx, dy) < 72) m.style.transform = `translate(${dx * 0.25}px, ${dy * 0.25}px)`;
        else if (m.style.transform) m.style.transform = '';
      }
    });
  };

  document.addEventListener('click', onClick);
  document.addEventListener('mousemove', onMove);
  return () => {
    document.removeEventListener('click', onClick);
    document.removeEventListener('mousemove', onMove);
    if (raf) cancelAnimationFrame(raf);
  };
}

function spawnRipple(el: HTMLElement, e: MouseEvent) {
  const r = el.getBoundingClientRect();
  const d = Math.max(r.width, r.height) * 2;
  const span = document.createElement('span');
  span.className = 'ripple';
  span.style.width = span.style.height = `${d}px`;
  span.style.left = `${e.clientX - r.left - d / 2}px`;
  span.style.top = `${e.clientY - r.top - d / 2}px`;
  el.appendChild(span);
  setTimeout(() => span.remove(), 600);
}

function spawnBurst(x: number, y: number, type: string) {
  const color = type === 'success' ? 'var(--color-success)' : type === 'danger' ? 'var(--color-danger)' : 'var(--color-primary)';
  for (let i = 0; i < 10; i++) {
    const p = document.createElement('span');
    p.className = 'burst';
    const ang = (Math.PI * 2 * i) / 10;
    const dist = 26 + Math.random() * 22;
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.style.background = color;
    p.style.setProperty('--bx', `${Math.cos(ang) * dist}px`);
    p.style.setProperty('--by', `${Math.sin(ang) * dist}px`);
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 620);
  }
}
