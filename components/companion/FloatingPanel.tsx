'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { COLLAPSED_INNER, POPOUT_HEIGHT, POPOUT_WIDTH } from '@/lib/companion/popout';
import { clampPanelPos, readCollapsed, readPanelPos, writePanelPos, type PanelPos } from '@/lib/companion/popoutState';
import { PopOutView, type PopOutHost } from './PopOutView';

const MARGIN = 16;

/**
 * The fallback when the browser has no Document Picture-in-Picture (stage 4, item 2): the pop-out as an in-page
 * floating panel, draggable by its header. Collapse shrinks it from the bottom (top / left stay fixed); the position
 * is saved under `companion_popout_pos` and clamped back on screen after a window resize.
 */
export const FloatingPanel: React.FC<{ date: string | null; user: string | null; event?: string | null; onClose: () => void }> = ({ date, user, event, onClose }) => {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(typeof window === 'undefined' ? null : window.localStorage));
  const height = collapsed ? COLLAPSED_INNER : POPOUT_HEIGHT;
  const [pos, setPos] = useState<PanelPos>(() => {
    if (typeof window === 'undefined') return { left: 0, top: 0 };
    const saved = readPanelPos(window.localStorage);
    const fallback = { left: window.innerWidth - POPOUT_WIDTH - MARGIN, top: window.innerHeight - POPOUT_HEIGHT - MARGIN };
    return clampPanelPos(saved ?? fallback, { width: POPOUT_WIDTH, height: POPOUT_HEIGHT }, { width: window.innerWidth, height: window.innerHeight });
  });
  const drag = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Clamped back on screen when the window shrinks.
  useEffect(() => {
    const onResize = () => setPos((p) => clampPanelPos(p, { width: POPOUT_WIDTH, height }, { width: window.innerWidth, height: window.innerHeight }));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [height]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Buttons and inputs inside the header keep their own behaviour; the bar itself is the handle.
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    if (e.button !== 0) return;
    drag.current = { pointerId: e.pointerId, dx: e.clientX - pos.left, dy: e.clientY - pos.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  }, [pos.left, pos.top]);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    setPos(clampPanelPos({ left: e.clientX - d.dx, top: e.clientY - d.dy }, { width: POPOUT_WIDTH, height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [height]);
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    setPos((p) => {
      if (!writePanelPos(window.localStorage, p)) console.error('[companion pop-out] the panel position could not be saved (browser storage unavailable)');
      return p;
    });
  }, []);

  const host = useMemo<PopOutHost>(
    () => ({
      kind: 'panel',
      // Collapse = the panel's height; top / left never change, so the top-left corner is held by construction.
      async resize(next) {
        setCollapsed(next);
        return null;
      },
      dragHandle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
      onClose,
    }),
    [onPointerDown, onPointerMove, onPointerUp, onClose],
  );

  // Only ever rendered after a click (or the ?popout=1 effect) — never on the server — so the portal target exists.
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      role="dialog"
      aria-label="Companion brief"
      data-testid="popout-panel"
      data-collapsed={collapsed ? 'true' : 'false'}
      style={{ position: 'fixed', left: pos.left, top: pos.top, width: POPOUT_WIDTH, height, zIndex: 'var(--z-overlay)' as unknown as number, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border-strong)', boxShadow: 'var(--shadow-lg)', background: 'var(--bg-canvas)', userSelect: dragging ? 'none' : undefined, transition: dragging ? 'none' : 'height 120ms ease' }}
    >
      <PopOutView date={date} user={user} event={event ?? null} host={host} previewState={null} />
    </div>,
    document.body,
  );
};
