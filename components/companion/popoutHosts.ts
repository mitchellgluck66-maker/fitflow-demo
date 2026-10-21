'use client';

import { COLLAPSED_INNER_MIN, POPOUT_HEIGHT, POPOUT_WIDTH } from '@/lib/companion/popout';
import { pipOuterHeight, type ScreenPos } from '@/lib/companion/popoutState';
import type { PopOutHost } from './PopOutView';

/** How long Chrome gets to apply a resize before the corner is measured again. */
export const RESIZE_SETTLE_MS = 250;

/**
 * Why a resize did not take: the window must have shrunk materially for the bar, or be back near full height.
 * Null = fine. Chrome clamps the bar to its own minimum (66 px inner), so the check is a direction, not a pixel.
 */
export function resizeRefusal(collapsed: boolean, after: { innerWidth: number; innerHeight: number }): string | null {
  if (collapsed && after.innerHeight > POPOUT_HEIGHT - 100) return `resize to the ${COLLAPSED_INNER_MIN} px bar refused — the window stayed at ${after.innerWidth}×${after.innerHeight}`;
  if (!collapsed && after.innerHeight < POPOUT_HEIGHT - 10) return `resize to ${POPOUT_WIDTH}×${POPOUT_HEIGHT} refused — the window stayed at ${after.innerWidth}×${after.innerHeight}`;
  return null;
}

/**
 * The Document Picture-in-Picture host: the page runs in an iframe of the PiP window, so the window to resize is
 * `window.top`. `resizeTo` sets the OUTER size; the title-bar delta is measured live. Called inside the click
 * handler (the activation propagates to the top window). Throws when the API is missing or the size did not change.
 */
export function pipHost(): PopOutHost {
  return {
    kind: 'pip',
    async resize(collapsed) {
      const top = window.top;
      if (!top || top === window || typeof top.resizeTo !== 'function') throw new Error('not inside a floating window — window.top.resizeTo is unavailable');
      const before: ScreenPos = { x: top.screenX, y: top.screenY };
      const delta = top.outerHeight - top.innerHeight;
      top.resizeTo(POPOUT_WIDTH, pipOuterHeight(collapsed, delta));
      await new Promise((r) => setTimeout(r, RESIZE_SETTLE_MS));
      const refusal = resizeRefusal(collapsed, { innerWidth: top.innerWidth, innerHeight: top.innerHeight });
      if (refusal) throw new Error(refusal);
      return { before, after: { x: top.screenX, y: top.screenY } };
    },
  };
}
