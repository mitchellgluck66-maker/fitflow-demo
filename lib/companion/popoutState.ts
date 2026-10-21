/**
 * Companion stage 4 — the pop-out's pure state: the ONE status chip, the collapse rule and its storage, the
 * footer's "what will happen" line, the collapsed bar's "next:" label, the window sizes and the move check.
 * No DOM here; `components/companion/PopOutView` and `PopOutButton` call these.
 */

import { formatTime } from '../day';
import { APPOINTMENT_WORDS } from './logText';
import { COLLAPSED_INNER, POPOUT_HEIGHT } from './popout';

// ---- status chip ------------------------------------------------------------------------------------------------

/** ghl = GoHighLevel could not be reached / refused a step; app = FitFlow's own API; window = resize / theme sync. */
export type PopOutProblemKind = 'ghl' | 'app' | 'window' | 'dry_run';

export interface PopOutProblem {
  kind: PopOutProblemKind;
  detail: string;
}

export interface StatusChipModel {
  tone: 'danger' | 'warning';
  label: 'GHL error' | 'Error' | 'Dry run';
  /** Every current problem, the red ones first — the popover lists them. */
  problems: PopOutProblem[];
}

const PRIORITY: Record<PopOutProblemKind, number> = { ghl: 0, app: 1, window: 1, dry_run: 2 };

/** ONE chip, top priority wins: "GHL error" (red) > "Error" (red: FitFlow API / the window) > "Dry run" (amber) > nothing. */
export function statusChip(problems: readonly PopOutProblem[]): StatusChipModel | null {
  const live = problems.filter((p) => p.detail.trim().length > 0);
  if (live.length === 0) return null;
  const sorted = [...live].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
  const top = sorted[0];
  const label: StatusChipModel['label'] = top.kind === 'ghl' ? 'GHL error' : top.kind === 'dry_run' ? 'Dry run' : 'Error';
  return { tone: top.kind === 'dry_run' ? 'warning' : 'danger', label, problems: sorted.map((p) => ({ kind: p.kind, detail: scrubEnvNames(p.detail) })) };
}

/** Env var names never appear in the pop-out: an UPPER_SNAKE token becomes "a server setting". */
export function scrubEnvNames(text: string): string {
  return text.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, 'a server setting');
}

// ---- collapse ----------------------------------------------------------------------------------------------------

export const COLLAPSED_KEY = 'companion_popout_collapsed';
export const PANEL_POS_KEY = 'companion_popout_pos';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readCollapsed(storage: StorageLike | null | undefined): boolean {
  try {
    return storage?.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** True when saved; false (never a throw) when the storage refuses — a private window, blocked site data. */
export function writeCollapsed(storage: StorageLike | null | undefined, collapsed: boolean): boolean {
  try {
    storage?.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    return Boolean(storage);
  } catch {
    return false;
  }
}

export interface PanelPos {
  left: number;
  top: number;
}

export function readPanelPos(storage: StorageLike | null | undefined): PanelPos | null {
  try {
    const raw = storage?.getItem(PANEL_POS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PanelPos>;
    return typeof v.left === 'number' && Number.isFinite(v.left) && typeof v.top === 'number' && Number.isFinite(v.top) ? { left: v.left, top: v.top } : null;
  } catch {
    return null;
  }
}

export function writePanelPos(storage: StorageLike | null | undefined, pos: PanelPos): boolean {
  try {
    storage?.setItem(PANEL_POS_KEY, JSON.stringify({ left: Math.round(pos.left), top: Math.round(pos.top) }));
    return Boolean(storage);
  } catch {
    return false;
  }
}

/** Fired on `window` after a collapse write so every open view (and a second window) re-reads the storage. */
export const COLLAPSED_EVENT = 'companion-popout:collapsed';

export type CollapseEvent = { type: 'toggle_button' } | { type: 'header_click' | 'header_dblclick' | 'new_call' | 'hover' | 'focus' | 'logged' | 'resize' };

/** ONLY the collapse button toggles. Every other event — header clicks, double-clicks, a new call, hover, focus, logging — is ignored. */
export function collapseReducer(collapsed: boolean, event: CollapseEvent): boolean {
  return event.type === 'toggle_button' ? !collapsed : collapsed;
}

/** The in-page panel's position, kept on screen: never past the viewport's right / bottom edge, never negative. */
export function clampPanelPos(pos: PanelPos, size: { width: number; height: number }, viewport: { width: number; height: number }): PanelPos {
  const maxLeft = Math.max(0, viewport.width - size.width);
  const maxTop = Math.max(0, viewport.height - size.height);
  return { left: Math.min(maxLeft, Math.max(0, Math.round(pos.left))), top: Math.min(maxTop, Math.max(0, Math.round(pos.top))) };
}

// ---- window geometry ------------------------------------------------------------------------------------------------

/** The PiP window's OUTER height for a state: the inner height plus the title-bar delta measured at run time. */
export function pipOuterHeight(collapsed: boolean, chromeDelta: number): number {
  return (collapsed ? COLLAPSED_INNER : POPOUT_HEIGHT) + Math.max(0, Math.round(chromeDelta));
}

export interface ScreenPos {
  x: number;
  y: number;
}

/** The top-left corner must not move on a toggle: held = both axes within 2 px. */
export function moveDelta(before: ScreenPos, after: ScreenPos): { dx: number; dy: number; held: boolean } {
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  return { dx, dy, held: Math.abs(dx) <= 2 && Math.abs(dy) <= 2 };
}

// ---- header title, footer line, collapsed bar -------------------------------------------------------------------------

/** "Today" for the business-local today, else "Mon, Oct 20" (the header has no room for the year). */
export function dayTitle(date: string, today: string | null | undefined): string {
  if (today && date === today) return 'Today';
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

export interface EffectInput {
  toStage: { name: string } | null;
  appointment: keyof typeof APPOINTMENT_WORDS;
  opportunityStatus: 'open' | 'won' | 'lost' | null;
}

export const PICK_LINE = 'Pick an outcome and write a note';

/** "Moves to Enrolled · marks showed · adds note" — exactly what Log outcome will do, from the outcome's own map. */
export function effectLine(outcome: EffectInput | null, ctx: { hasCall: boolean; dryRun: boolean }): string {
  if (!outcome) return PICK_LINE;
  const parts: string[] = [outcome.toStage ? `Moves to ${outcome.toStage.name}` : 'Stage unchanged'];
  if (ctx.hasCall && outcome.appointment !== 'leave') parts.push(`marks ${APPOINTMENT_WORDS[outcome.appointment]}`);
  if (outcome.opportunityStatus === 'won' || outcome.opportunityStatus === 'lost') parts.push(`marks the deal ${outcome.opportunityStatus}`);
  parts.push('adds note');
  if (ctx.dryRun) parts.push('dry run — nothing sent');
  return parts.join(' · ');
}

/** The collapsed bar's "next: Jo 3:00" (first name, no meridiem); "last call" when nothing follows. */
export function nextCallLabel(calls: ReadonlyArray<{ name: string; startIso: string }>, index: number | null, timezone: string): string {
  if (index === null || index < 0) return calls.length ? `next: ${shortCall(calls[0], timezone)}` : '';
  const next = calls[index + 1];
  return next ? `next: ${shortCall(next, timezone)}` : 'last call';
}

function shortCall(c: { name: string; startIso: string }, timezone: string): string {
  const first = c.name.trim().split(/\s+/)[0] || c.name;
  return `${first} ${formatTime(c.startIso, timezone).replace(/\s?[AP]M$/i, '')}`;
}
