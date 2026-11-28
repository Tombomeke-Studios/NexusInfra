import { motionEnabled } from './motion';

// Interaction layer from the design (NexusInfra.dc.html script):
//  - the animated background node-network canvas (data-bg-net), drifting on its own,
//  - click ripples on [data-ripple] and particle bursts on [data-burst].
// Delegated at the document level; inert when motion is reduced.
//
// Nothing here follows the pointer any more (#449). The design also had a glowing
// aura with a trail of dots, a spotlight inside cards, "magnetic" buttons and a
// network that reached for the cursor; on the sign-in page — the first thing a new
// customer sees — that read as distracting, and a magnetic button moves the very
// target someone is aiming at.
export function initInteractionFx(): () => void {
  if (!motionEnabled()) return () => {};

  const fxLayer = document.getElementById('fx-layer');
  const disposeNet = initNetwork();

  const onDown = (e: MouseEvent) => {
    const t = (e.target as HTMLElement).closest?.('[data-ripple]') as HTMLElement | null;
    if (t) ripple(t, e.clientX, e.clientY);
  };
  const onClick = (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest?.('[data-burst]') as HTMLElement | null;
    if (b && fxLayer) burst(fxLayer, e.clientX, e.clientY, b.getAttribute('data-burst') || 'primary');
  };

  document.addEventListener('mousedown', onDown);
  document.addEventListener('click', onClick);
  return () => {
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('click', onClick);
    disposeNet();
  };
}

// `#rgb`/`#rrggbb` → the "r,g,b" string used in the canvas's rgba() strokes.
export function hexToRgb(hex: string): string | null {
  let h = (hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

interface NetNode { x: number; y: number; vx: number; vy: number; r: number; ph: number }
interface Packet { a: NetNode; b: NetNode; t: number; sp: number }

// The background node-network (design: initNetwork). Drifting nodes link to nearby
// neighbours and occasionally stream a "packet" along a link. It ignores the
// pointer (#449). Returns a disposer; a no-op where there's no 2D canvas (e.g.
// jsdom in tests).
function initNetwork(): () => void {
  const c = document.querySelector<HTMLCanvasElement>('canvas[data-bg-net]');
  const ctx = c?.getContext('2d');
  if (!c || !ctx) return () => {};

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let W = 0;
  let H = 0;
  const resize = () => {
    const w = c.clientWidth || window.innerWidth;
    const h = c.clientHeight || window.innerHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    W = w;
    H = h;
  };
  window.addEventListener('resize', resize);

  const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
  const col = hexToRgb(getComputedStyle(document.documentElement).getPropertyValue('--color-primary')) || '99,102,241';
  const LINK = 155;
  let nodes: NetNode[] = [];
  const packets: Packet[] = [];
  let raf = 0;
  let stopped = false;
  let tries = 0;

  const draw = () => {
    if (stopped) return;
    const t = performance.now() / 1000;
    ctx.clearRect(0, 0, W, H);

    // Drift + wrap.
    for (const p of nodes) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < -30) p.x = W + 30;
      if (p.x > W + 30) p.x = -30;
      if (p.y < -30) p.y = H + 30;
      if (p.y > H + 30) p.y = -30;
    }
    // Links between nearby nodes.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const A = nodes[i];
        const B = nodes[j];
        const d = Math.hypot(A.x - B.x, A.y - B.y);
        if (d < LINK) {
          ctx.strokeStyle = `rgba(${col},${(1 - d / LINK) * 0.26})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(A.x, A.y);
          ctx.lineTo(B.x, B.y);
          ctx.stroke();
        }
      }
    }
    // Occasionally launch a packet toward the nearest neighbour.
    if (Math.random() < 0.07 && nodes.length > 3) {
      const A = nodes[(Math.random() * nodes.length) | 0];
      let best: NetNode | null = null;
      let bd = LINK;
      for (const B of nodes) {
        if (B === A) continue;
        const d = Math.hypot(A.x - B.x, A.y - B.y);
        if (d < bd) {
          best = B;
          bd = d;
        }
      }
      if (best) packets.push({ a: A, b: best, t: 0, sp: rnd(0.01, 0.024) });
    }
    // Advance + draw packets.
    for (let k = packets.length - 1; k >= 0; k--) {
      const pk = packets[k];
      pk.t += pk.sp;
      if (pk.t >= 1) {
        packets.splice(k, 1);
        continue;
      }
      const x = pk.a.x + (pk.b.x - pk.a.x) * pk.t;
      const y = pk.a.y + (pk.b.y - pk.a.y) * pk.t;
      ctx.fillStyle = `rgba(${col},0.28)`;
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, 6.29);
      ctx.fill();
      ctx.fillStyle = `rgba(${col},0.95)`;
      ctx.beginPath();
      ctx.arc(x, y, 2.3, 0, 6.29);
      ctx.fill();
    }
    // Nodes: a slow pulse.
    for (const p of nodes) {
      const pulse = 0.55 + 0.45 * Math.sin(t * 1.5 + p.ph);
      ctx.fillStyle = `rgba(${col},${0.5 * pulse})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, 6.29);
      ctx.fill();
    }
    raf = requestAnimationFrame(draw);
  };

  // Wait until the canvas has a real layout size before seeding nodes (the design
  // retries the same way) — seeding against a zero-width canvas renders nothing.
  const boot = () => {
    if (stopped) return;
    if (!(c.clientWidth > 0 || window.innerWidth > 0) && tries++ < 300) {
      requestAnimationFrame(boot);
      return;
    }
    resize();
    const n = Math.max(38, Math.min(84, Math.round((W * H) / 18000)));
    nodes = Array.from({ length: n }, () => ({ x: rnd(0, W), y: rnd(0, H), vx: rnd(-0.26, 0.26), vy: rnd(-0.26, 0.26), r: rnd(1.2, 2.9), ph: rnd(0, 6.28) }));
    raf = requestAnimationFrame(draw);
  };
  boot();

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
  };
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
