/**
 * Companion stage 1 → 4 — the pop-out window (pure helpers; the DOM work is in components/companion/PopOutButton).
 *
 * Chrome 116+ has Document Picture-in-Picture: an always-on-top window the page fills itself. We fill it with an
 * iframe of /companion/popout (`host=pip`) so the brief is an ordinary page (navigable, screenshot-able, the same
 * cookies). Any other browser gets an in-page floating panel (stage 4) — never a plain popup — and the settings
 * popover says the browser cannot float the brief.
 */

export const POPOUT_WIDTH = 360;
/** The expanded INNER height: the layout never scrolls at 360×560. */
export const POPOUT_HEIGHT = 560;
/** The collapsed INNER height the bar is designed for — Chrome's floor is `COLLAPSED_INNER_MIN`. */
export const COLLAPSED_INNER = 48;
/** Measured 2026-10-21 (Chrome 155): `resizeTo` never goes below an inner height of 66 px (outer 100). */
export const COLLAPSED_INNER_MIN = 66;
export const POPOUT_PATH = '/companion/popout';

export type PopOutMode = 'document_pip' | 'panel';
/** Where the pop-out page is running: the PiP iframe, the in-page panel, or a plain browser tab. */
export type PopOutHostKind = 'pip' | 'panel' | 'tab';

export interface DocumentPipHost {
  documentPictureInPicture?: { requestWindow(options?: { width?: number; height?: number }): Promise<Window>; window?: Window | null };
}

/** True when the host exposes the Document Picture-in-Picture API (Chrome 116+, Edge 116+). */
export function supportsDocumentPip(host: DocumentPipHost | null | undefined): boolean {
  return Boolean(host && typeof host.documentPictureInPicture?.requestWindow === 'function');
}

export function popOutMode(host: DocumentPipHost | null | undefined): PopOutMode {
  return supportsDocumentPip(host) ? 'document_pip' : 'panel';
}

/** The pop-out page URL for a day / user / event; `host=pip` inside the floating window, `float=0` in a plain tab. */
export function popOutUrl(p: { date?: string | null; user?: string | null; event?: string | null; host: PopOutHostKind }): string {
  const q = new URLSearchParams();
  if (p.date) q.set('date', p.date);
  if (p.user) q.set('user', p.user);
  if (p.event) q.set('event', p.event);
  if (p.host === 'pip') q.set('host', 'pip');
  if (p.host === 'tab') q.set('float', '0');
  const s = q.toString();
  return s ? `${POPOUT_PATH}?${s}` : POPOUT_PATH;
}

/** The size to ask Chrome for: the saved collapsed state's size, so a reopened window matches (and keeps its place). */
export function requestedPipSize(collapsed: boolean): { width: number; height: number } {
  return { width: POPOUT_WIDTH, height: collapsed ? COLLAPSED_INNER_MIN : POPOUT_HEIGHT };
}

/**
 * The markup the PiP window is filled with: one iframe that fills it. The wrapper carries the opener's theme and
 * its canvas colour (read from the `--bg-canvas` token at open time — never a literal), so nothing flashes.
 */
export function pipDocumentHtml(url: string, opts: { title?: string; theme: 'light' | 'dark'; background: string }): string {
  const safe = url.replace(/"/g, '&quot;');
  const title = opts.title ?? 'FitFlow Companion';
  const bg = /^[#a-z0-9(),.% -]+$/i.test(opts.background.trim()) ? opts.background.trim() : 'transparent';
  return `<!doctype html><html lang="en" data-theme="${opts.theme}" style="color-scheme:${opts.theme}"><head><meta charset="utf-8"><title>${title}</title><style>html,body{margin:0;height:100%;background:${bg}}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><iframe src="${safe}" title="${title}" allow="clipboard-write"></iframe></body></html>`;
}
