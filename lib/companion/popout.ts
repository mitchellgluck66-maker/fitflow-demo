/**
 * Companion stage 1 — the pop-out window (pure helpers; the DOM work is in components/companion/PopOutButton).
 *
 * Chrome 116+ has Document Picture-in-Picture: an always-on-top window the page fills itself. We fill it with an
 * iframe of /companion/popout so the brief is an ordinary page (navigable, screenshot-able, the same cookies). Any
 * other browser gets a plain popup window of the same page with `float=0`, and the page says it cannot float.
 */

export const POPOUT_WIDTH = 360;
export const POPOUT_HEIGHT = 520;
export const POPOUT_PATH = '/companion/popout';

export type PopOutMode = 'document_pip' | 'window';

export interface DocumentPipHost {
  documentPictureInPicture?: { requestWindow(options?: { width?: number; height?: number }): Promise<Window> };
}

/** True when the host exposes the Document Picture-in-Picture API (Chrome 116+, Edge 116+). */
export function supportsDocumentPip(host: DocumentPipHost | null | undefined): boolean {
  return Boolean(host && typeof host.documentPictureInPicture?.requestWindow === 'function');
}

export function popOutMode(host: DocumentPipHost | null | undefined): PopOutMode {
  return supportsDocumentPip(host) ? 'document_pip' : 'window';
}

/** The pop-out page URL for a day / user / event, with `float=0` when the window cannot stay on top. */
export function popOutUrl(p: { date?: string | null; user?: string | null; event?: string | null; mode: PopOutMode }): string {
  const q = new URLSearchParams();
  if (p.date) q.set('date', p.date);
  if (p.user) q.set('user', p.user);
  if (p.event) q.set('event', p.event);
  if (p.mode === 'window') q.set('float', '0');
  const s = q.toString();
  return s ? `${POPOUT_PATH}?${s}` : POPOUT_PATH;
}

/** window.open features for the fallback popup. */
export function popupFeatures(): string {
  return `popup=yes,width=${POPOUT_WIDTH},height=${POPOUT_HEIGHT},resizable=yes,scrollbars=yes`;
}

/** The markup the PiP window is filled with: one iframe that fills it. */
export function pipDocumentHtml(url: string, title = 'FitFlow Companion'): string {
  const safe = url.replace(/"/g, '&quot;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>html,body{margin:0;height:100%;background:#0f1013}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><iframe src="${safe}" title="${title}" allow="clipboard-write"></iframe></body></html>`;
}
