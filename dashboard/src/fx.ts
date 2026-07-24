import { motionEnabled } from './motion';

// Interaction layer from the design (NexusInfra.dc.html script):
//  - a cursor-follow aura that smoothly lerps toward the pointer and emits a
//    fading trail of dots,
//  - click ripples on [data-ripple] and particle bursts on [data-burst],
//  - a spotlight glow inside [data-spotlight] cards, and magnetic pull on
//    [data-magnetic].
// Delegated at the document level; inert when motion is reduced.
export function initInteractionFx(): () => void {
  if (!motionEnabled()) return () => {};

  const aura = document.getElementById('cursor-aura');
  const fxLayer = document.getElementById('fx-layer');
  const a = { x: window.innerWidth / 2, y: window.innerHeight / 2, tx: window.innerWidth / 2, ty: window.innerHeight / 2 };
  let lastTrail = 0;
  let raf = 0;
  let lastSpot: HTMLElement | null = null;

  const onMove = (e: MouseEvent) => {
    a.tx = e.clientX;
    a.ty = e.clientY;
    if (aura) aura.style.opacity = '1';
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      // Spotlight follows the cursor inside the hovered card.
      const spot = (e.target as HTMLElement).closest?.('[data-spotlight]') as HTMLElement | null;
      if (lastSpot && lastSpot !== spot) lastSpot.style.setProperty('--spot', '0');
      if (spot) {
        const r = spot.getBoundingClientRect();
        spot.style.setProperty('--mx', `${e.clientX - r.left}px`);
        spot.style.setProperty('--my', `${e.clientY - r.top}px`);
        spot.style.setProperty('--spot', '1');
      }
      lastSpot = spot;
      // Magnetic pull on nearby elements.
      for (const m of Array.from(document.querySelectorAll<HTMLElement>('[data-magnetic]'))) {
        const r = m.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        if (Math.hypot(dx, dy) < 72) m.style.transform = `translate(${dx * 0.25}px, ${dy * 0.25}px)`;
        else if (m.style.transform) m.style.transform = '';
      }
    });
  };

  const onLeave = () => {
    if (aura) aura.style.opacity = '0';
  };

  const onDown = (e: MouseEvent) => {
    const t = (e.target as HTMLElement).closest?.('[data-ripple]') as HTMLElement | null;
    if (t) ripple(t, e.clientX, e.clientY);
  };
  const onClick = (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest?.('[data-burst]') as HTMLElement | null;
    if (b && fxLayer) burst(fxLayer, e.clientX, e.clientY, b.getAttribute('data-burst') || 'primary');
  };

  // Aura easing loop + trail.
  let loopRaf = 0;
  const loop = () => {
    a.x += (a.tx - a.x) * 0.16;
    a.y += (a.ty - a.y) * 0.16;
    if (aura) aura.style.transform = `translate(${a.x}px, ${a.y}px)`;
    const now = performance.now();
    if (now - lastTrail > 28) {
      lastTrail = now;
      if (Math.hypot(a.tx - a.x, a.ty - a.y) > 3.5 && fxLayer) trail(fxLayer, a.tx, a.ty);
    }
    loopRaf = requestAnimationFrame(loop);
  };
  loopRaf = requestAnimationFrame(loop);

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseleave', onLeave);
  document.addEventListener('mousedown', onDown);
  document.addEventListener('click', onClick);
  return () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseleave', onLeave);
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('click', onClick);
    if (raf) cancelAnimationFrame(raf);
    cancelAnimationFrame(loopRaf);
  };
}

function trail(fx: HTMLElement, x: number, y: number) {
  const el = document.createElement('div');
  const s = 5 + Math.random() * 4;
  el.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${s}px;height:${s}px;margin:${-s / 2}px 0 0 ${-s / 2}px;border-radius:50%;background:var(--color-primary);opacity:.5`;
  fx.appendChild(el);
  el.animate([{ transform: 'scale(1)', opacity: 0.5 }, { transform: 'scale(0)', opacity: 0 }], { duration: 600, easing: 'ease-out' }).onfinish = () => el.remove();
}

function ripple(el: HTMLElement, x: number, y: number) {
  const r = el.getBoundingClientRect();
  const d = Math.max(r.width, r.height) * 2.2;
  const s = document.createElement('span');
  s.style.cssText = `position:absolute;left:${x - r.left - d / 2}px;top:${y - r.top - d / 2}px;width:${d}px;height:${d}px;border-radius:50%;background:currentColor;opacity:.28;pointer-events:none`;
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  el.appendChild(s);
  s.animate([{ transform: 'scale(0)', opacity: 0.28 }, { transform: 'scale(1)', opacity: 0 }], { duration: 560, easing: 'ease-out' }).onfinish = () => s.remove();
}

function burst(fx: HTMLElement, x: number, y: number, kind: string) {
  const palette =
    ({ success: ['#22c55e', '#4ade80', '#a7f3d0'], danger: ['#ef4444', '#f87171', '#fca5a5'], primary: ['#6366f1', '#818cf8', '#c4b5fd', '#14b8a6'] } as Record<string, string[]>)[kind] || ['#6366f1'];
  const n = kind === 'success' ? 26 : 14;
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    const sz = 5 + Math.random() * 6;
    el.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${sz}px;height:${sz}px;margin:${-sz / 2}px 0 0 ${-sz / 2}px;border-radius:${Math.random() < 0.5 ? '50%' : '2px'};background:${palette[i % palette.length]}`;
    fx.appendChild(el);
    const ang = Math.random() * Math.PI * 2;
    const dist = (kind === 'success' ? 90 : 55) + Math.random() * 70;
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist - (kind === 'success' ? 30 : 0);
    el.animate(
      [
        { transform: 'translate(0,0) rotate(0) scale(1)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy + 70}px) rotate(${Math.random() * 540}deg) scale(.3)`, opacity: 0 },
      ],
      { duration: 700 + Math.random() * 500, easing: 'cubic-bezier(.2,.7,.3,1)' }
    ).onfinish = () => el.remove();
  }
}
