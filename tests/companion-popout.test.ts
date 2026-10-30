/**
 * Companion stage 4 — the pop-out redesign: the ONE status chip's priority, env names never shown, the collapse rule
 * (only the button toggles) and its storage, the footer's effect line, the collapsed bar's "next:" label, the window
 * geometry helpers, the theme sync, and the header's markup (exactly one expand/collapse control, no double-click).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  clampPanelPos,
  collapseReducer,
  dayTitle,
  effectLine,
  moveDelta,
  nextCallLabel,
  pipOuterHeight,
  readCollapsed,
  readPanelPos,
  scrubEnvNames,
  statusChip,
  writeCollapsed,
  writePanelPos,
  COLLAPSED_KEY,
  PANEL_POS_KEY,
  type StorageLike,
} from '@/lib/companion/popoutState';
import { PopOutHeader, CollapsedBar } from '@/components/companion/PopOutParts';
import { resizeRefusal } from '@/components/companion/popoutHosts';
import { startThemeSync, themeOf, type AttrSource, type ThemeTarget } from '@/lib/companion/popoutTheme';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('status chip: one chip, top priority wins', () => {
  it('GHL error (red) > Error (red) > Dry run (amber) > nothing', () => {
    expect(statusChip([])).toBeNull();
    expect(statusChip([{ kind: 'dry_run', detail: 'nothing is sent' }])).toMatchObject({ tone: 'warning', label: 'Dry run' });
    expect(statusChip([{ kind: 'dry_run', detail: 'nothing is sent' }, { kind: 'window', detail: 'resize refused' }])).toMatchObject({ tone: 'danger', label: 'Error' });
    expect(statusChip([{ kind: 'dry_run', detail: 'x' }, { kind: 'app', detail: 'day failed' }, { kind: 'ghl', detail: 'GHL 503' }])).toMatchObject({ tone: 'danger', label: 'GHL error' });
    // The popover lists every problem, the red ones first.
    const chip = statusChip([{ kind: 'dry_run', detail: 'x' }, { kind: 'ghl', detail: 'GHL 503' }, { kind: 'app', detail: 'day failed' }]);
    expect(chip?.problems.map((p) => p.kind)).toEqual(['ghl', 'app', 'dry_run']);
    // A blank detail is not a problem.
    expect(statusChip([{ kind: 'ghl', detail: '   ' }])).toBeNull();
  });

  it('env var names never appear: UPPER_SNAKE tokens become "a server setting"', () => {
    expect(scrubEnvNames('RESEND_API_KEY is not configured')).toBe('a server setting is not configured');
    expect(scrubEnvNames('set CREDENTIALS_KEY and GHL_API_KEY in Vercel')).toBe('set a server setting and a server setting in Vercel');
    expect(scrubEnvNames('GHL 422 PUT /opportunities/x: {"message":"bad"}')).toBe('GHL 422 PUT /opportunities/x: {"message":"bad"}');
    expect(scrubEnvNames('the role consult_noshow has no stage')).toBe('the role consult_noshow has no stage');
    expect(statusChip([{ kind: 'app', detail: 'Could not load: RESEND_API_KEY missing' }])?.problems[0].detail).not.toContain('RESEND_API_KEY');
  });
});

describe('collapse: only the button toggles; the state is saved', () => {
  it('collapseReducer flips on the button and on nothing else', () => {
    expect(collapseReducer(false, { type: 'toggle_button' })).toBe(true);
    expect(collapseReducer(true, { type: 'toggle_button' })).toBe(false);
    for (const type of ['header_click', 'header_dblclick', 'new_call', 'hover', 'focus', 'logged', 'resize'] as const) {
      expect(collapseReducer(false, { type })).toBe(false);
      expect(collapseReducer(true, { type })).toBe(true);
    }
  });

  it('the state persists under companion_popout_collapsed; a broken storage reads as expanded and never throws', () => {
    const store = new Map<string, string>();
    const storage: StorageLike = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) };
    expect(readCollapsed(storage)).toBe(false);
    expect(writeCollapsed(storage, true)).toBe(true);
    expect(store.get(COLLAPSED_KEY)).toBe('1');
    expect(readCollapsed(storage)).toBe(true);
    expect(writeCollapsed(storage, false)).toBe(true);
    expect(readCollapsed(storage)).toBe(false);
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(readCollapsed(broken)).toBe(false);
    expect(writeCollapsed(broken, true)).toBe(false);
    expect(readCollapsed(null)).toBe(false);
    expect(writeCollapsed(undefined, true)).toBe(false);
  });

  it('the fallback panel position persists under companion_popout_pos and is clamped on screen', () => {
    const store = new Map<string, string>();
    const storage: StorageLike = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) };
    expect(readPanelPos(storage)).toBeNull();
    expect(writePanelPos(storage, { left: 100.6, top: 20.2 })).toBe(true);
    expect(store.get(PANEL_POS_KEY)).toBe('{"left":101,"top":20}');
    expect(readPanelPos(storage)).toEqual({ left: 101, top: 20 });
    store.set(PANEL_POS_KEY, '{"left":"x"}');
    expect(readPanelPos(storage)).toBeNull();
    store.set(PANEL_POS_KEY, 'not json');
    expect(readPanelPos(storage)).toBeNull();
    expect(clampPanelPos({ left: 2000, top: -40 }, { width: 360, height: 560 }, { width: 1440, height: 900 })).toEqual({ left: 1080, top: 0 });
    expect(clampPanelPos({ left: 10, top: 10 }, { width: 360, height: 560 }, { width: 300, height: 400 })).toEqual({ left: 0, top: 0 }); // a viewport smaller than the panel pins it top-left
  });

  it('the header renders exactly ONE expand/collapse control (aria-label + aria-expanded), and nothing handles a double-click', () => {
    const header = renderToStaticMarkup(React.createElement(PopOutHeader, { title: 'Today · 2 of 4', chip: null, canPrev: true, canNext: true, onPrev: () => {}, onNext: () => {}, settings: null, collapsed: false, onToggleCollapse: () => {} }));
    expect(header.match(/aria-expanded=/g)).toHaveLength(1);
    expect(header).toContain('aria-label="Collapse"');
    expect(header).toContain('aria-expanded="true"');
    const bar = renderToStaticMarkup(React.createElement(CollapsedBar, { name: 'Jordan Rivers', time: '1:45 PM', next: 'next: Jo 3:00', chip: null, onToggleCollapse: () => {} }));
    expect(bar.match(/aria-expanded=/g)).toHaveLength(1);
    expect(bar).toContain('aria-label="Expand"');
    expect(bar).toContain('aria-expanded="false"');
    expect(bar).not.toContain('data-testid="log-pick"'); // no outcome buttons in the bar
    // Source guard: the only onClick wired to the toggle is the CollapseButton's; no onDoubleClick anywhere in the pop-out.
    for (const file of ['components/companion/PopOutParts.tsx', 'components/companion/PopOutView.tsx', 'components/companion/PopOut.tsx', 'components/companion/PopOutButton.tsx']) {
      const src = read(file);
      expect(src, file).not.toMatch(/onDoubleClick/);
    }
    const parts = read('components/companion/PopOutParts.tsx');
    expect(parts.match(/onClick=\{onToggle\}/g)).toHaveLength(1);
    expect(parts.match(/onToggle=\{onToggleCollapse\}/g)).toHaveLength(2); // the header and the collapsed bar hand it ONLY to CollapseButton
    expect(parts.match(/onToggleCollapse\}/g)?.length ?? 0).toBeLessThanOrEqual(2);
    const view = read('components/companion/PopOutView.tsx');
    expect(view.match(/onToggleCollapse=\{toggleCollapsed\}/g)).toHaveLength(2);
    expect(view.match(/toggleCollapsed/g)).toHaveLength(3); // the definition + the two props
  });

  it('no env var name is written into the pop-out components', () => {
    for (const file of ['components/companion/PopOutParts.tsx', 'components/companion/PopOutView.tsx', 'components/companion/PopOut.tsx']) {
      const src = read(file).replace(/process\.env\.NODE_ENV/g, '');
      expect(src, file).not.toMatch(/\b(RESEND|CREDENTIALS|GHL_API|APP_PASSWORD|AUTH_SECRET|CRON_SECRET|DATABASE_URL|META|STRIPE)[A-Z_]*\b/);
    }
  });
});

describe('footer line, titles, geometry', () => {
  it('effectLine says exactly what Log outcome will do', () => {
    expect(effectLine(null, { hasCall: true, dryRun: false })).toBe('Pick an outcome and write a note');
    expect(effectLine({ toStage: { name: 'Enrolled' }, appointment: 'showed', opportunityStatus: 'won' }, { hasCall: true, dryRun: false })).toBe('Moves to Enrolled · marks showed · marks the deal won · adds note');
    expect(effectLine({ toStage: { name: 'Consult No Show' }, appointment: 'noshow', opportunityStatus: 'open' }, { hasCall: true, dryRun: false })).toBe('Moves to Consult No Show · marks no-show · adds note');
    expect(effectLine({ toStage: null, appointment: 'showed', opportunityStatus: 'lost' }, { hasCall: true, dryRun: true })).toBe('Stage unchanged · marks showed · marks the deal lost · adds note · dry run — nothing sent');
    expect(effectLine({ toStage: { name: 'Enrolled' }, appointment: 'leave', opportunityStatus: null }, { hasCall: true, dryRun: false })).toBe('Moves to Enrolled · appointment unchanged · adds note');
    expect(effectLine({ toStage: { name: 'Consult Reschedule' }, appointment: 'leave', opportunityStatus: 'open' }, { hasCall: true, dryRun: false })).toBe('Moves to Consult Reschedule · appointment unchanged · adds note'); // stage 5: a Reschedule visibly does NOT cancel
    expect(effectLine({ toStage: { name: 'Enrolled' }, appointment: 'showed', opportunityStatus: null }, { hasCall: false, dryRun: false })).toBe('Moves to Enrolled · adds note'); // no call → no appointment to mark
  });

  it('nextCallLabel: "next: Jo 3:00" (first name, no meridiem), "last call" at the end', () => {
    const calls = [
      { name: 'Jordan Rivers', startIso: '2026-10-16T16:00:00Z' },
      { name: 'Jo Lee', startIso: '2026-10-16T21:00:00Z' },
    ];
    expect(nextCallLabel(calls, 0, 'America/Edmonton')).toBe('next: Jo 3:00');
    expect(nextCallLabel(calls, 1, 'America/Edmonton')).toBe('last call');
    expect(nextCallLabel(calls, null, 'America/Edmonton')).toBe('next: Jordan 10:00');
    expect(nextCallLabel([], null, 'America/Edmonton')).toBe('');
  });

  it('dayTitle: "Today" or "Mon, Oct 20"', () => {
    expect(dayTitle('2026-10-21', '2026-10-21')).toBe('Today');
    expect(dayTitle('2026-10-20', '2026-10-21')).toBe('Tue, Oct 20');
    expect(dayTitle('2026-10-20', null)).toBe('Tue, Oct 20');
  });

  it('resizeRefusal: a resize that did not take is named, never swallowed (Chrome clamps the bar to 66 px, so the check is a direction)', () => {
    expect(resizeRefusal(true, { innerWidth: 360, innerHeight: 66 })).toBeNull();
    expect(resizeRefusal(true, { innerWidth: 360, innerHeight: 100 })).toBeNull();
    expect(resizeRefusal(true, { innerWidth: 360, innerHeight: 560 })).toBe('resize to the 66 px bar refused — the window stayed at 360×560');
    expect(resizeRefusal(false, { innerWidth: 360, innerHeight: 560 })).toBeNull();
    expect(resizeRefusal(false, { innerWidth: 360, innerHeight: 66 })).toBe('resize to 360×560 refused — the window stayed at 360×66');
  });

  it('pipOuterHeight adds the measured title bar; moveDelta holds within 2 px', () => {
    expect(pipOuterHeight(false, 34)).toBe(594);
    expect(pipOuterHeight(true, 34)).toBe(82);
    expect(pipOuterHeight(true, -5)).toBe(48);
    expect(moveDelta({ x: 100, y: 200 }, { x: 101, y: 198 })).toEqual({ dx: 1, dy: -2, held: true });
    expect(moveDelta({ x: 100, y: 200 }, { x: 100, y: 203 })).toEqual({ dx: 0, dy: 3, held: false });
  });
});

describe('theme sync: the pop-out follows the opener\'s data-theme, live', () => {
  /** A fake <html>: an attribute bag whose observers fire when data-theme changes. */
  const fakeRoot = () => {
    const attrs = new Map<string, string>();
    const listeners = new Set<() => void>();
    const root: AttrSource & ThemeTarget & { set(theme: string): void; attrs: Map<string, string>; style: { colorScheme?: string } } = {
      attrs,
      style: {},
      getAttribute: (n) => attrs.get(n) ?? null,
      setAttribute: (n, v) => void attrs.set(n, v),
      set(theme) {
        attrs.set('data-theme', theme);
        listeners.forEach((l) => l());
      },
    };
    const observe = (_r: AttrSource, cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    };
    return { root, observe, listeners };
  };

  it('copies the theme on start, on every change (incl. a system-mode OS flip written by the ThemeProvider), and stops', () => {
    const opener = fakeRoot();
    opener.root.set('dark');
    const wrapper = fakeRoot().root;
    const iframe = fakeRoot().root;
    const painted: string[] = [];
    const errors: string[] = [];
    const sync = startThemeSync({ source: opener.root, targets: () => [wrapper, iframe], observe: opener.observe, paint: (t) => painted.push(t), onError: (d) => errors.push(d) });
    expect(wrapper.attrs.get('data-theme')).toBe('dark');
    expect(iframe.attrs.get('data-theme')).toBe('dark');
    expect(iframe.style.colorScheme).toBe('dark');
    expect(painted).toEqual(['dark']);
    opener.root.set('light'); // the app's toggle, or the OS in "system" mode
    expect(wrapper.attrs.get('data-theme')).toBe('light');
    expect(iframe.attrs.get('data-theme')).toBe('light');
    expect(painted).toEqual(['dark', 'light']);
    sync.stop();
    opener.root.set('dark');
    expect(iframe.attrs.get('data-theme')).toBe('light'); // no longer following
    expect(errors).toEqual([]);
    expect(themeOf({ getAttribute: () => null })).toBe('light');
  });

  it('a target that throws (a closed window) is reported, never thrown; the other targets still update', () => {
    const opener = fakeRoot();
    opener.root.set('light');
    const good = fakeRoot().root;
    const closed: ThemeTarget = {
      setAttribute: () => {
        throw new Error('window closed');
      },
    };
    const errors: string[] = [];
    startThemeSync({ source: opener.root, targets: () => [closed, good], observe: opener.observe, onError: (d) => errors.push(d) });
    expect(good.attrs.get('data-theme')).toBe('light');
    expect(errors).toEqual(['Theme sync to the pop-out failed (light): window closed']);
    opener.root.set('dark');
    expect(good.attrs.get('data-theme')).toBe('dark');
    expect(errors).toHaveLength(2);
  });

  it('a browser without MutationObserver still gets the one-time copy, and says it will not follow', () => {
    const opener = fakeRoot();
    opener.root.set('dark');
    const t = fakeRoot().root;
    const errors: string[] = [];
    startThemeSync({
      source: opener.root,
      targets: () => [t],
      observe: () => {
        throw new Error('MutationObserver is unavailable in this browser');
      },
      onError: (d) => errors.push(d),
    });
    expect(t.attrs.get('data-theme')).toBe('dark');
    expect(errors).toEqual(['Theme sync will not follow changes: MutationObserver is unavailable in this browser']);
  });
});
