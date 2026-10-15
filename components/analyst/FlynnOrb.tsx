'use client';

import { useEffect, useRef } from 'react';
import { createFlynnOrb, PURPLE, type FlynnOrbHandle } from './orbEngine';

/** The purple orb (demo colours). `speed` changes live; reduced motion draws one static frame. */
export function FlynnOrb({ size, particles = 140, speed = 1, glitch = true, className }: { size: number; particles?: number; speed?: number; glitch?: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const handle = useRef<FlynnOrbHandle | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    handle.current = createFlynnOrb(canvas, { size, particles, speed, glitch: glitch && !reduced, static: Boolean(reduced), ...PURPLE });
    return () => {
      handle.current?.destroy();
      handle.current = null;
    };
    // The engine is created once; speed is pushed through setSpeed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, particles, glitch]);
  useEffect(() => {
    handle.current?.setSpeed(speed);
  }, [speed]);
  return <canvas ref={ref} className={className} width={size} height={size} style={{ width: size, height: size, display: 'block' }} aria-hidden="true" />;
}
