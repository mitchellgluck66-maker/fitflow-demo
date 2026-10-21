/**
 * Companion stage 4 — the pop-out follows the main app's theme, live. The OPENER owns the sync: it copies its own
 * `<html data-theme>` into every target root (the PiP wrapper document and the iframe's document) on start and on
 * every change — a MutationObserver on the opener's `<html>`, so "system" mode is covered too (the ThemeProvider
 * writes the attribute when the OS flips). DOM-typed through small interfaces so the rule is unit-tested with fakes.
 */

export type Theme = 'light' | 'dark';

export interface AttrSource {
  getAttribute(name: string): string | null;
}

export interface ThemeTarget {
  setAttribute(name: string, value: string): void;
  style?: { colorScheme?: string };
}

/** Observe `data-theme` on a root; returns the disconnect. The default wraps MutationObserver; tests inject a fake. */
export type ObserveAttr = (root: AttrSource, onChange: () => void) => () => void;

export const observeDataTheme: ObserveAttr = (root, onChange) => {
  if (typeof MutationObserver === 'undefined') throw new Error('MutationObserver is unavailable in this browser');
  const o = new MutationObserver(onChange);
  o.observe(root as unknown as Node, { attributes: true, attributeFilter: ['data-theme'] });
  return () => o.disconnect();
};

export function themeOf(source: AttrSource): Theme {
  return source.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export interface ThemeSync {
  /** Copy the current theme now (the opener calls it again when the iframe finishes loading). */
  apply(): void;
  stop(): void;
}

/**
 * Start following `source`: `targets()` is read on every apply so a not-yet-loaded iframe is simply absent and picked
 * up later; `paint(theme)` colours the wrapper from the opener's tokens; a target that throws is reported through
 * `onError` (the opener posts it into the pop-out's status chip and console.error) — never thrown, never silent.
 */
export function startThemeSync(p: { source: AttrSource; targets: () => ThemeTarget[]; observe?: ObserveAttr; paint?: (theme: Theme) => void; onError: (detail: string) => void }): ThemeSync {
  const apply = () => {
    const theme = themeOf(p.source);
    let applied = 0;
    for (const t of p.targets()) {
      try {
        t.setAttribute('data-theme', theme);
        if (t.style) t.style.colorScheme = theme;
        applied += 1;
      } catch (e) {
        p.onError(`Theme sync to the pop-out failed (${theme}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try {
      p.paint?.(theme);
    } catch (e) {
      p.onError(`Theme sync could not paint the window (${theme}): ${e instanceof Error ? e.message : String(e)}`);
    }
    return applied;
  };
  let stop = () => {};
  try {
    stop = (p.observe ?? observeDataTheme)(p.source, apply);
  } catch (e) {
    p.onError(`Theme sync will not follow changes: ${e instanceof Error ? e.message : String(e)}`);
  }
  apply();
  return { apply, stop };
}
