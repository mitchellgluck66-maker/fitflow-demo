/**
 * The Flynn orb engine from docs/fitflow-analyst-demo.html, ported as is (typed; the maths, timing and glitch are the
 * demo's). A canvas of particles on a sphere, projected, rotated, drawn with additive blending and a radial glow.
 * `speed` scales the clock (the thinking state runs at 2.4); `setColors` / `setSpeed` / `destroy` as in the demo.
 * `static: true` draws ONE frame and never animates (reduced motion).
 */

export interface FlynnOrbOptions {
  size?: number;
  particles?: number;
  base?: [number, number, number];
  bright?: [number, number, number];
  glowColor?: string;
  speed?: number;
  glitch?: boolean;
  fps?: number;
  static?: boolean;
}

export interface FlynnOrbHandle {
  destroy(): void;
  setColors(c: { base?: [number, number, number]; bright?: [number, number, number]; glowColor?: string }): void;
  setSpeed(s: number): void;
  resize(): void;
}

export const PURPLE = { base: [143, 102, 255] as [number, number, number], bright: [228, 216, 255] as [number, number, number], glowColor: '143,102,255' };

export function createFlynnOrb(canvas: HTMLCanvasElement, options: FlynnOrbOptions = {}): FlynnOrbHandle {
  const o = { size: 64, particles: 140, base: [34, 211, 238] as [number, number, number], bright: [186, 244, 255] as [number, number, number], glowColor: '34,211,238', speed: 1, glitch: true, fps: 30, static: false, ...options };
  const ctx = canvas.getContext('2d');
  if (!ctx) return { destroy() {}, setColors() {}, setSpeed() {}, resize() {} };
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  let W = 0;
  let H = 0;
  let B = o.base.join(',');
  let BR = o.bright.join(',');
  function size() {
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width || o.size));
    H = Math.max(1, Math.round(r.height || o.size));
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    ctx!.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  const parts: Array<{ phi: number; theta: number; r: number; jit: number; gl: number }> = [];
  for (let i = 0; i < o.particles; i++) parts.push({ phi: Math.acos(1 - (2 * (i + 0.5)) / o.particles), theta: Math.PI * (1 + Math.sqrt(5)) * i, r: 0.68 + Math.random() * 0.34, jit: Math.random() * Math.PI * 2, gl: Math.random() });
  let et = 0;
  let raf: number | null = null;
  let last = 0;
  let alive = true;
  function draw() {
    if (!W) size();
    const c = ctx!;
    c.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) * 0.4;
    const scale = R / (58 * 0.4);
    const rotY = et * 0.6;
    const rotX = Math.sin(et * 0.33) * 0.5;
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, R * 1.6);
    g.addColorStop(0, `rgba(${o.glowColor},0.28)`);
    g.addColorStop(0.55, `rgba(${o.glowColor},0.08)`);
    g.addColorStop(1, `rgba(${o.glowColor},0)`);
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'lighter';
    const proj: Array<{ x: number; y: number; z: number; p: (typeof parts)[number] }> = [];
    for (const p of parts) {
      const x = Math.sin(p.phi) * Math.cos(p.theta + rotY);
      let y = Math.cos(p.phi);
      let z = Math.sin(p.phi) * Math.sin(p.theta + rotY);
      const y2 = y * Math.cos(rotX) - z * Math.sin(rotX);
      const z2 = y * Math.sin(rotX) + z * Math.cos(rotX);
      y = y2;
      z = z2;
      const rr = p.r * (1 + Math.sin(et * 3 + p.jit) * 0.05);
      proj.push({ x: x * rr, y: y * rr, z: z * rr, p });
    }
    proj.sort((a, b) => a.z - b.z);
    for (const q of proj) {
      const depth = (q.z + 1) / 2;
      const sx = cx + q.x * R;
      const sy = cy + q.y * R;
      const sz = (1.3 + depth * 2.4) * scale;
      let gx = 0;
      let gy = 0;
      if (o.glitch && Math.sin(et * 2.3 + q.p.gl * 12) > 0.98) {
        gx = (Math.random() - 0.5) * 6 * scale;
        gy = (Math.random() - 0.5) * 6 * scale;
      }
      const a = 0.22 + depth * 0.78;
      c.fillStyle = `rgba(${depth > 0.62 ? BR : B},${a})`;
      c.fillRect(sx + gx - sz / 2, sy + gy - sz / 2, sz, sz);
    }
    c.globalCompositeOperation = 'source-over';
    et += 0.016 * o.speed;
  }
  function loop(ts: number) {
    if (!alive) return;
    raf = requestAnimationFrame(loop);
    if (ts - last < 1000 / o.fps) return;
    last = ts;
    draw();
  }
  const onResize = () => size();
  size();
  window.addEventListener('resize', onResize);
  if (o.static) {
    et = 1.7; // a pleasing frozen pose
    draw();
  } else raf = requestAnimationFrame(loop);
  return {
    destroy() {
      alive = false;
      if (raf !== null) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    },
    setColors(c) {
      if (c.base) o.base = c.base;
      if (c.bright) o.bright = c.bright;
      if (c.glowColor) o.glowColor = c.glowColor;
      B = o.base.join(',');
      BR = o.bright.join(',');
    },
    setSpeed(s) {
      o.speed = s;
    },
    resize: size,
  };
}
