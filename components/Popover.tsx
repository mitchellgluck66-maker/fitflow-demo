'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The one way to float a panel over the page. Renders into document.body
 * through a portal at `--z-popover`, positioned against an anchor's viewport
 * rect, so no card, animation or transform in the page tree can ever put a
 * panel behind content. Closes on Esc and on pointer-down outside the panel
 * and its anchor. Re-anchors on scroll/resize.
 */
export const Popover: React.FC<{
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Panel width in px, or a CSS width. Default: fit the anchor at least. */
  width?: number | string;
  /** Align the panel's left or right edge with the anchor. */
  align?: 'left' | 'right';
  role?: 'dialog' | 'menu' | 'listbox';
  'aria-labelledby'?: string;
  className?: string;
  children: React.ReactNode;
}> = ({ open, anchorRef, onClose, width, align = 'left', role = 'dialog', className, children, ...aria }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; right: number; minWidth: number; anchorTop: number; vh: number; panelH: number } | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      if (!a) return;
      setPos({ top: a.bottom + 6, left: a.left, right: window.innerWidth - a.right, minWidth: a.width, anchorTop: a.top, vh: window.innerHeight, panelH: panelRef.current?.offsetHeight ?? 0 });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    // Content that loads after opening changes the panel's height — re-place so it never hangs off-screen.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    const observe = () => panelRef.current && ro?.observe(panelRef.current);
    const raf = requestAnimationFrame(observe);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, onClose, anchorRef]);

  if (!open || !mounted || !pos) return null;

  // Below the anchor unless the panel does not fit there and there is more room above (a tile near the bottom of
  // a phone screen); either way capped to the viewport and scrollable, so it is always reachable.
  const below = pos.vh - pos.top - 8;
  const above = pos.anchorTop - 14;
  const flip = pos.panelH > below && above > below;
  const style: React.CSSProperties = {
    position: 'fixed',
    ...(flip ? { bottom: pos.vh - pos.anchorTop + 6, maxHeight: above } : { top: pos.top, maxHeight: Math.max(160, below) }),
    overflowY: 'auto',
    zIndex: 'var(--z-popover)' as unknown as number,
    minWidth: typeof width === 'number' ? undefined : pos.minWidth,
    width: width ?? undefined,
    maxWidth: 'calc(100vw - 16px)',
    background: 'var(--surface-raised)',
    border: '1px solid var(--border-default)',
    boxShadow: 'var(--shadow-lg)',
    ...(align === 'left' ? { left: Math.max(8, pos.left) } : { right: Math.max(8, pos.right) }),
  };

  return createPortal(
    <div ref={panelRef} role={role} tabIndex={-1} className={`rounded-[10px] animate-scale focus:outline-none ${className ?? ''}`} style={style} {...aria}>
      {children}
    </div>,
    document.body,
  );
};
