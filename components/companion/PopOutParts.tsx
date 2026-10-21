'use client';

import React, { useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, ExternalLink, Loader2, Minus, RotateCcw, Settings2, Undo2, X } from 'lucide-react';
import { Badge, Toggle } from '@/components';
import { Popover } from '@/components/Popover';
import { formatTime } from '@/lib/day';
import type { CompanionCall } from '@/lib/companion/day';
import type { ClientBrief, SearchRow } from '@/lib/companion/brief';
import type { ActionView } from '@/lib/companion/log';
import type { PopOutHostKind } from '@/lib/companion/popout';
import { effectLine, PICK_LINE, type StatusChipModel } from '@/lib/companion/popoutState';
import { NOTE_MIN_CHARS } from '@/lib/companion/logText';
import type { OutcomeLog } from './useOutcomeLog';

const iconButton = 'h-8 w-8 grid place-items-center rounded-[7px] hover:bg-[var(--surface-hover)] disabled:opacity-30 disabled:hover:bg-transparent focus-ring shrink-0';

/** The small accent square at the left of the header — the Companion's mark. */
export const AccentMark: React.FC = () => <span aria-hidden className="inline-block h-[10px] w-[10px] rounded-[3px] shrink-0" style={{ background: 'var(--accent)' }} />;

/**
 * ONE status chip (lib/companion/popoutState#statusChip): red "GHL error" / "Error", amber "Dry run", or nothing.
 * Clicking it opens a short popover with every detail. The chip is a button so the detail is one click away.
 */
export const StatusChipButton: React.FC<{ chip: StatusChipModel | null; defaultOpen?: boolean }> = ({ chip, defaultOpen }) => {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(Boolean(defaultOpen));
  if (!chip) return null;
  return (
    <>
      <button ref={ref} type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open} data-testid="popout-status-chip" data-tone={chip.tone} className="focus-ring rounded-[5px] shrink-0">
        <Badge variant={chip.tone} size="xs" dot>
          {chip.label}
        </Badge>
      </button>
      <Popover open={open} anchorRef={ref} onClose={() => setOpen(false)} width={300} align="left" aria-label="Status details">
        <div className="px-3 py-2.5 space-y-2 text-[12px]" data-testid="popout-status-popover">
          {chip.problems.map((p, i) => (
            <p key={i} className="leading-snug break-words" style={{ color: p.kind === 'dry_run' ? 'var(--text-primary)' : 'var(--danger)' }}>
              <span className="font-semibold">{p.kind === 'ghl' ? 'GoHighLevel' : p.kind === 'dry_run' ? 'Dry run' : p.kind === 'window' ? 'Pop-out' : 'FitFlow'}</span>
              <span style={{ color: 'var(--text-secondary)' }}> · {p.detail}</span>
            </p>
          ))}
        </div>
      </Popover>
    </>
  );
};

/** The collapse / expand control — the ONLY thing that toggles (aria-label + aria-expanded for the tests and screen readers). */
export const CollapseButton: React.FC<{ collapsed: boolean; onToggle: () => void }> = ({ collapsed, onToggle }) => (
  <button type="button" onClick={onToggle} aria-label={collapsed ? 'Expand' : 'Collapse'} aria-expanded={!collapsed} title={collapsed ? 'Expand' : 'Collapse'} data-testid="popout-collapse" className={iconButton} style={{ color: 'var(--text-secondary)' }}>
    {collapsed ? <ChevronsUpDown size={15} /> : <ChevronsDownUp size={15} />}
  </button>
);

export interface HeaderProps {
  title: string;
  chip: StatusChipModel | null;
  chipOpen?: boolean;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  settings: React.ReactNode;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onClose?: () => void;
  dragHandle?: React.HTMLAttributes<HTMLDivElement>;
}

/** Header 48 px: accent mark · "Today · 2 of 4" · chip · ‹ › · settings · collapse (far right). Clicking the bar itself does nothing. */
export const PopOutHeader: React.FC<HeaderProps> = ({ title, chip, chipOpen, canPrev, canNext, onPrev, onNext, settings, collapsed, onToggleCollapse, onClose, dragHandle }) => (
  <div className="h-12 shrink-0 flex items-center gap-1.5 pl-3 pr-1.5 select-none" data-testid="popout-header" style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--surface-overlay)', cursor: dragHandle ? 'grab' : undefined }} {...dragHandle}>
    <AccentMark />
    <span className="text-[12.5px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
      {title}
    </span>
    <StatusChipButton key={chipOpen ? 'open' : 'closed'} chip={chip} defaultOpen={chipOpen} />
    <div className="ml-auto flex items-center">
      <button type="button" aria-label="Previous call" onClick={onPrev} disabled={!canPrev} className={iconButton} style={{ color: 'var(--text-secondary)' }}>
        <ChevronLeft size={16} />
      </button>
      <button type="button" aria-label="Next call" onClick={onNext} disabled={!canNext} className={iconButton} style={{ color: 'var(--text-secondary)' }}>
        <ChevronRight size={16} />
      </button>
      {settings}
      {onClose && (
        <button type="button" aria-label="Close" onClick={onClose} className={iconButton} style={{ color: 'var(--text-secondary)' }}>
          <X size={15} />
        </button>
      )}
      <CollapseButton collapsed={collapsed} onToggle={onToggleCollapse} />
    </div>
  </div>
);

/** Collapsed = the header row as a bar: name · time · "next: Jo 3:00" · chip · expand. No outcome buttons. */
export const CollapsedBar: React.FC<{ name: string; time: string; next: string; chip: StatusChipModel | null; onToggleCollapse: () => void; dragHandle?: React.HTMLAttributes<HTMLDivElement> }> = ({ name, time, next, chip, onToggleCollapse, dragHandle }) => (
  <div className="h-full min-h-12 flex items-center gap-2 pl-3 pr-1.5 select-none" data-testid="popout-collapsed" style={{ background: 'var(--surface-overlay)', cursor: dragHandle ? 'grab' : undefined }} {...dragHandle}>
    <AccentMark />
    <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
      {name}
    </span>
    {time && (
      <span className="text-[12px] tabular shrink-0" style={{ color: 'var(--text-secondary)' }}>
        {time}
      </span>
    )}
    {next && (
      <span className="text-[11.5px] truncate" style={{ color: 'var(--text-tertiary)' }}>
        {next}
      </span>
    )}
    <span className="ml-auto flex items-center gap-1.5">
      <StatusChipButton chip={chip} />
      <CollapseButton collapsed onToggle={onToggleCollapse} />
    </span>
  </div>
);

/** The gear's popover: find someone, auto-advance, where the window is, links. The "can't float" sentence lives here, never as a banner. */
export const SettingsPopover: React.FC<{
  host: PopOutHostKind;
  autoAdvance: boolean | null;
  hasRow: boolean;
  onAutoAdvance: (v: boolean) => void;
  search: { q: string; onChange: (v: string) => void; results: { results: SearchRow[]; liveError: string | null } | null; searching: boolean; onPick: (r: SearchRow) => void };
}> = ({ host, autoAdvance, hasRow, onAutoAdvance, search }) => {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={ref} type="button" aria-label="Pop-out settings" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={iconButton} style={{ color: 'var(--text-secondary)' }}>
        <Settings2 size={15} />
      </button>
      <Popover open={open} anchorRef={ref} onClose={() => setOpen(false)} width={320} align="right" aria-label="Pop-out settings">
        <div className="px-3 py-2.5 space-y-3 text-[12px]" style={{ color: 'var(--text-primary)' }}>
          <div>
            <label className="block text-[10.5px] uppercase tracking-wide mb-1" style={{ color: 'var(--text-quaternary)' }} htmlFor="popout-search">
              Find someone
            </label>
            <input id="popout-search" type="search" value={search.q} onChange={(e) => search.onChange(e.target.value)} placeholder="Name or email" className="w-full h-8 px-2.5 text-[12.5px] rounded-[7px] focus-ring" style={{ background: 'var(--surface)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} />
            {search.results && (
              <ul className="mt-1 rounded-[7px] overflow-hidden max-h-[180px] overflow-y-auto" style={{ border: '1px solid var(--border-subtle)' }} aria-label="Search results">
                {search.results.results.length === 0 && !search.searching && (
                  <li className="px-2.5 py-1.5" style={{ color: 'var(--text-tertiary)' }}>
                    No one matches “{search.q}”.
                  </li>
                )}
                {search.results.results.slice(0, 6).map((r) => (
                  <li key={r.ghlContactId}>
                    <button
                      type="button"
                      onClick={() => {
                        search.onPick(r);
                        setOpen(false);
                      }}
                      className="w-full text-left px-2.5 py-1.5 hover:bg-[var(--surface-hover)] focus-ring"
                    >
                      <span className="font-medium">{r.name}</span>
                      <span className="ml-1.5 text-[11px]" style={{ color: 'var(--text-quaternary)' }}>
                        {r.email ?? r.phone ?? ''}
                        {r.source === 'live' ? ' · GHL' : ''}
                      </span>
                    </button>
                  </li>
                ))}
                {search.results.liveError && (
                  <li className="px-2.5 py-1 text-[11px]" style={{ color: 'var(--danger)', borderTop: '1px solid var(--border-subtle)' }}>
                    GoHighLevel search unavailable: {search.results.liveError}
                  </li>
                )}
              </ul>
            )}
          </div>
          <Toggle checked={autoAdvance ?? true} disabled={autoAdvance === null || !hasRow} onChange={onAutoAdvance} label="Auto-advance to the next call" description={hasRow ? 'Follows the clock: the call starting within 10 minutes, then the next.' : 'Sign in with a personal login to change this.'} />
          <p className="leading-snug" style={{ color: 'var(--text-secondary)' }}>
            {host === 'pip' ? 'Floating window — stays on top of other windows. Drag it by its title bar.' : host === 'panel' ? "This browser can't float the brief over other windows. Use Chrome 116+ for an always-on-top window; here it floats inside the FitFlow tab — drag it by its header." : 'Open from My day → Pop out for a floating window.'}
          </p>
          <div className="flex gap-3 text-[12px]">
            <a href="/companion" target="_blank" rel="noopener" className="underline underline-offset-2 focus-ring rounded" style={{ color: 'var(--accent)' }}>
              My day
            </a>
            <a href="/companion/settings" target="_blank" rel="noopener" className="underline underline-offset-2 focus-ring rounded" style={{ color: 'var(--accent)' }}>
              Companion settings
            </a>
          </div>
        </div>
      </Popover>
    </>
  );
};

const STATUS_WORD: Record<CompanionCall['status'], { text: (c: CompanionCall) => string; color: string }> = {
  up_next: { text: () => 'Up next', color: 'var(--info)' },
  in_progress: { text: () => 'In progress', color: 'var(--accent)' },
  needs_outcome: { text: () => 'Needs outcome', color: 'var(--warning)' },
  logged: { text: (c) => `Logged${c.action ? ` · ${c.action.label}` : ''}`, color: 'var(--success)' },
  dry_run: { text: (c) => `Dry run${c.action ? ` · ${c.action.label}` : ''}`, color: 'var(--warning)' },
  failed: { text: (c) => `Failed${c.action?.failedStep ? ` · ${c.action.failedStep}` : ''}`, color: 'var(--danger)' },
  ghl_outcome: { text: (c) => (c.outcomeInGhl === 'showed' ? 'Showed in GHL' : c.outcomeInGhl === 'no_show' ? 'No-show in GHL' : 'Cancelled in GHL'), color: 'var(--text-tertiary)' },
};

export const timeRangeOf = (c: { startIso: string; endIso: string | null }, tz: string) => (c.endIso ? `${formatTime(c.startIso, tz)}–${formatTime(c.endIso, tz)}` : formatTime(c.startIso, tz));

/** "Roadmap · 1:45–2:45 PM · Up next", the name 20 px / 700, the chips (stage · days in pipeline · Open in GHL). */
export const BriefBlock: React.FC<{ brief: ClientBrief | null; call: CompanionCall | null; fromSearch: boolean; onBackToCall: () => void; timezone: string; loading: boolean }> = ({ brief, call, fromSearch, onBackToCall, timezone, loading }) => {
  if (!brief) {
    return (
      <div className="px-3 pt-2.5 pb-1 shrink-0" style={{ minHeight: 84 }}>
        <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
          {loading ? 'Loading the brief…' : 'Pick a call with the arrows or find someone in settings.'}
        </p>
      </div>
    );
  }
  const status = call && !fromSearch ? STATUS_WORD[call.status] : null;
  return (
    <div className="px-3 pt-2.5 pb-1 shrink-0 min-w-0">
      <div className="text-[11.5px] truncate flex items-center gap-1" style={{ color: 'var(--text-tertiary)' }}>
        {call && !fromSearch ? (
          <>
            <span style={{ color: call.callType === 'Roadmap' ? 'var(--accent)' : call.callType === 'Consult' ? 'var(--info)' : 'var(--text-tertiary)' }} className="font-medium">
              {call.callType === 'Other' ? call.calendarName : call.callType}
            </span>
            <span>· {timeRangeOf(call, timezone)}</span>
            {status && (
              <span className="font-medium" style={{ color: status.color }}>
                · {status.text(call)}
              </span>
            )}
          </>
        ) : (
          <>
            <span>From search</span>
            <button type="button" onClick={onBackToCall} className="underline underline-offset-2 focus-ring rounded" style={{ color: 'var(--accent)' }}>
              back to the call
            </button>
          </>
        )}
      </div>
      <h1 className="text-[20px] font-bold leading-tight tracking-[-0.015em] truncate mt-0.5" style={{ color: 'var(--text-primary)' }} title={brief.contact.name}>
        {brief.contact.name}
      </h1>
      <div className="flex items-center gap-1.5 mt-1.5 min-w-0 overflow-hidden">
        <Badge variant="neutral" size="xs" className="max-w-[150px]">
          <span className="truncate">{brief.stage ? brief.stage.name : brief.contact.inMirror ? 'not in a tracked pipeline' : 'not in the mirror yet'}</span>
        </Badge>
        <Badge variant="outline" size="xs">
          {brief.daysInPipeline ? `${brief.daysInPipeline.days} d in pipeline` : 'no application date'}
        </Badge>
        {brief.ghlUrl ? (
          <a href={brief.ghlUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 h-[18px] px-1.5 rounded-[4px] text-[10.5px] font-medium border focus-ring shrink-0" style={{ color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 26%, transparent)', background: 'var(--accent-muted)' }}>
            Open in GHL <ExternalLink size={10} />
          </a>
        ) : (
          <span title="No GoHighLevel page for this contact (no location configured, or a sample row)" className="inline-flex items-center gap-1 h-[18px] px-1.5 rounded-[4px] text-[10.5px] border shrink-0" style={{ color: 'var(--text-quaternary)', borderColor: 'var(--border-subtle)' }}>
            Open in GHL
          </span>
        )}
      </div>
    </div>
  );
};

/** 2×3 grid of 40 px outcome buttons; selected = accent border + tint; the sixth cell is "Move to…". */
export const OutcomeGrid: React.FC<{ log: OutcomeLog; hasCall: boolean }> = ({ log, hasCall }) => {
  const moveRef = useRef<HTMLButtonElement>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const list = log.outcomes?.outcomes ?? [];
  const move = log.outcomes?.moveTo;
  const selectedMove = log.choice && 'move' in log.choice ? log.choice.move : null;
  const cell = (on: boolean) => ({ background: on ? 'var(--accent-muted)' : 'var(--surface-raised)', color: on ? 'var(--accent)' : 'var(--text-primary)', border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border-default)'}` });
  if (!log.outcomes && !log.outcomesError) {
    return (
      <p className="text-[11.5px]" style={{ color: 'var(--text-quaternary)' }}>
        Loading outcomes…
      </p>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-1.5 shrink-0" data-testid="log-pick" role="group" aria-label="Outcome">
      {list.slice(0, 5).map((o) => {
        const on = Boolean(log.choice && 'key' in log.choice && log.choice.key === o.key);
        return (
          <button key={o.key} type="button" disabled={Boolean(o.unavailable)} aria-pressed={on} title={o.unavailable ?? (o.toStage ? `→ ${o.toStage.name} · appointment ${o.appointment}` : `appointment ${o.appointment}`)} onClick={() => log.setChoice({ key: o.key })} className="h-10 px-2 rounded-[8px] text-[12px] font-medium truncate focus-ring disabled:cursor-not-allowed disabled:opacity-45" style={cell(on)}>
            {o.label}
          </button>
        );
      })}
      {move && (
        <>
          <button ref={moveRef} type="button" disabled={!move.pipeline} aria-pressed={Boolean(selectedMove)} aria-haspopup="dialog" title={move.pipeline ? `Any stage of ${move.pipeline.name}` : 'Follow a pipeline in Setup first'} onClick={() => setMoveOpen((v) => !v)} className="h-10 px-2 rounded-[8px] text-[12px] font-medium truncate focus-ring disabled:opacity-45" style={cell(Boolean(selectedMove))}>
            {selectedMove ? `Move to · ${move.stages.find((s) => s.id === selectedMove.stageId)?.name ?? ''}` : 'Move to…'}
          </button>
          <Popover open={moveOpen && Boolean(move.pipeline)} anchorRef={moveRef} onClose={() => setMoveOpen(false)} width={300} align="right" aria-label="Move to a stage">
            <div className="px-3 py-2.5 space-y-2 text-[12px]">
              <div className="text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--text-quaternary)' }}>
                Move to any stage of {move.pipeline?.name}
              </div>
              <select aria-label="Move to stage" value={selectedMove?.stageId ?? ''} onChange={(e) => log.setChoice(e.target.value ? { move: { stageId: e.target.value, appointment: selectedMove?.appointment ?? (hasCall ? 'showed' : 'leave') } } : null)} className="w-full h-8 rounded-[7px] px-2 text-[12px]" style={{ background: 'var(--surface)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
                <option value="">Pick a stage…</option>
                {move.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select aria-label="Move to appointment status" value={selectedMove?.appointment ?? (hasCall ? 'showed' : 'leave')} disabled={!selectedMove || !hasCall} onChange={(e) => selectedMove && log.setChoice({ move: { stageId: selectedMove.stageId, appointment: e.target.value as 'showed' } })} className="w-full h-8 rounded-[7px] px-2 text-[12px]" style={{ background: 'var(--surface)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
                {move.appointments.map((a) => (
                  <option key={a} value={a}>
                    {a === 'noshow' ? 'mark no-show' : a === 'leave' ? 'leave the appointment' : `mark ${a}`}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => setMoveOpen(false)} className="h-8 w-full rounded-[7px] text-[12px] font-semibold focus-ring" style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}>
                Done
              </button>
            </div>
          </Popover>
        </>
      )}
    </div>
  );
};

/** The note (~76 px) with "4 / 10". */
export const NoteField: React.FC<{ log: OutcomeLog }> = ({ log }) => (
  <div className="shrink-0">
    <textarea value={log.note} onChange={(e) => log.setNote(e.target.value)} placeholder="Call note (required) — what happened, what was agreed, next step" aria-label="Call note" className="w-full h-[76px] resize-none rounded-[8px] px-2.5 py-2 text-[12.5px] leading-snug focus-ring" style={{ background: 'var(--surface)', border: `1px solid ${log.note && !log.noteOk ? 'var(--warning)' : 'var(--border-default)'}`, color: 'var(--text-primary)' }} />
    <div className="text-right text-[10.5px] tabular -mt-0.5" style={{ color: log.noteOk ? 'var(--text-quaternary)' : 'var(--warning)' }}>
      {log.noteOk ? 'Note ready' : `${log.noteLen} / ${NOTE_MIN_CHARS}`}
    </div>
  </div>
);

/** "Last note · Oct 12 · <text>" in one or two lines. */
export const LastNote: React.FC<{ notes: ClientBrief['notes'] | null }> = ({ notes }) => {
  if (!notes) return null;
  let text: string;
  if (notes.status === 'unavailable') text = 'Last note unavailable — see the status chip';
  else if (notes.items.length === 0) text = 'No notes in GoHighLevel yet';
  else {
    const n = notes.items[0];
    const when = n.dateAdded ? new Date(n.dateAdded).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
    text = `Last note${when ? ` · ${when}` : ''} · ${n.body.replace(/\s+/g, ' ').trim()}`;
  }
  return (
    <p className="text-[11.5px] leading-snug line-clamp-2 shrink-0 min-h-[16px]" style={{ color: 'var(--text-tertiary)' }} title={text}>
      {text}
    </p>
  );
};

const StepIcon: React.FC<{ status: string }> = ({ status }) => {
  if (status === 'ok') return <Check size={13} strokeWidth={2.5} style={{ color: 'var(--success)' }} aria-label="done" />;
  if (status === 'failed') return <X size={13} strokeWidth={2.5} style={{ color: 'var(--danger)' }} aria-label="failed" />;
  if (status === 'dry_run') return <Check size={13} strokeWidth={2.5} style={{ color: 'var(--warning)' }} aria-label="dry run" />;
  if (status === 'pending') return <Loader2 size={13} className="animate-spin" style={{ color: 'var(--text-quaternary)' }} aria-label="pending" />;
  return <Minus size={13} strokeWidth={2.5} style={{ color: 'var(--text-quaternary)' }} aria-label="skipped" />;
};

export const resultTitle = (a: ActionView) => (a.state === 'ok' ? 'Logged' : a.state === 'dry_run' ? 'Dry run — logged, not sent' : a.state === 'undone' ? `Undone${a.undoneBy ? ` by ${a.undoneBy}` : ''}` : a.state === 'partial' ? 'Partly applied' : a.state === 'running' ? 'Logging…' : 'Failed');
export const resultTone = (a: ActionView) => (a.state === 'ok' ? 'var(--success)' : a.state === 'dry_run' ? 'var(--warning)' : a.state === 'undone' ? 'var(--text-tertiary)' : 'var(--danger)');

/** After confirm: the three per-step checks (✓ / ✗ / –), Retry on the failing step. Takes the grid's place in the body. */
export const ResultSteps: React.FC<{ action: ActionView; busy: string | null; onRetry: () => void; timezone: string }> = ({ action: a, busy, onRetry, timezone }) => (
  <section aria-label="Outcome" data-testid="log-result" data-state={a.state} className="flex-1 min-h-0 overflow-y-auto rounded-[8px] px-2.5 py-2 space-y-1.5" style={{ border: `1px solid ${resultTone(a)}`, background: 'var(--surface-raised)' }}>
    <div className="flex items-center justify-between gap-2">
      <div className="text-[12.5px] font-semibold truncate" style={{ color: resultTone(a) }}>
        {resultTitle(a)} · {a.label}
      </div>
      <div className="text-[10.5px] tabular shrink-0" style={{ color: 'var(--text-quaternary)' }}>
        {formatTime(a.createdAt, timezone)} · {a.userName}
      </div>
    </div>
    <ul className="space-y-1" aria-label="Steps">
      {a.steps.map((s) => (
        <li key={s.name} className="flex items-start gap-1.5 text-[12px]">
          <span className="mt-0.5 shrink-0">
            <StepIcon status={s.status} />
          </span>
          <div className="min-w-0 flex-1">
            <div className={s.status === 'skipped' ? '' : 'font-medium'} style={{ color: s.status === 'skipped' ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
              {s.summary}
              {s.status === 'dry_run' && <span style={{ color: 'var(--warning)' }}> · dry run — not sent</span>}
            </div>
            {s.detail && (
              <div className="text-[11px] break-words" style={{ color: s.status === 'failed' ? 'var(--danger)' : 'var(--text-quaternary)' }}>
                {s.detail}
              </div>
            )}
          </div>
          {s.status === 'failed' && a.canRetry && (
            <button type="button" onClick={onRetry} disabled={busy !== null} className="shrink-0 inline-flex items-center gap-1 h-6 px-1.5 rounded-[5px] text-[11px] font-medium focus-ring" style={{ background: 'var(--danger-muted)', color: 'var(--danger)', border: '1px solid var(--danger)' }}>
              <RotateCcw size={11} /> {busy === 'retry' ? 'Retrying…' : 'Retry'}
            </button>
          )}
        </li>
      ))}
    </ul>
    {a.error && (
      <p className="text-[11.5px] flex items-start gap-1.5 break-words" style={{ color: 'var(--danger)' }}>
        <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {a.error}
      </p>
    )}
  </section>
);

/** Fixed footer: "Log outcome" (44 px) + ONE line saying what will happen; the two-step confirm lives in the button. */
export const LogFooter: React.FC<{ log: OutcomeLog; hasCall: boolean; hasTarget: boolean; timezone: string }> = ({ log, hasCall, hasTarget, timezone }) => {
  const { phase } = log;
  const primary = 'h-11 rounded-[10px] text-[13.5px] font-semibold focus-ring disabled:opacity-50 inline-flex items-center justify-center gap-2';
  const secondary = `${primary} px-4`;
  let controls: React.ReactNode;
  let line: string;
  let lineColor = 'var(--text-tertiary)';
  if (phase.kind === 'pick') {
    controls = (
      <button type="button" onClick={log.plan} disabled={!log.canLog || !hasTarget} data-testid="log-button" className={`${primary} w-full`} style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}>
        {log.busy === 'plan' ? 'Preparing…' : 'Log outcome'}
      </button>
    );
    line = log.error ?? (hasTarget ? effectLine(log.selected, { hasCall, dryRun: log.dryRun }) : PICK_LINE);
    if (log.error) lineColor = 'var(--danger)';
  } else if (phase.kind === 'confirm' || phase.kind === 'running') {
    const p = phase.plan;
    const running = phase.kind === 'running';
    const stale = phase.kind === 'confirm' ? phase.stale : null;
    controls = (
      <div className="flex gap-2">
        <button type="button" onClick={log.cancel} disabled={running} className={secondary} style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
          Cancel
        </button>
        <button type="button" onClick={log.confirm} disabled={running} data-testid="log-confirm-button" className={`${primary} flex-1 min-w-0`} style={{ background: p.dryRun ? 'var(--warning)' : 'var(--accent)', color: 'var(--accent-text)' }}>
          {running ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Logging…
            </>
          ) : (
            <span className="truncate">{stale ? 'Continue anyway' : `Confirm: ${p.outcome.label}`}</span>
          )}
        </button>
      </div>
    );
    if (log.error) {
      line = log.error;
      lineColor = 'var(--danger)';
    } else if (stale) {
      line = `Stage changed to ${stale.stageName ?? 'another stage'} since you opened this — Continue anyway logs on top of it`;
      lineColor = 'var(--warning)';
    } else {
      line = running ? 'Writing to GoHighLevel…' : effectLine({ toStage: p.outcome.toStage, appointment: p.outcome.appointment, opportunityStatus: p.outcome.opportunityStatus }, { hasCall: p.appointment !== null, dryRun: p.dryRun });
    }
  } else {
    const a = phase.action;
    controls = (
      <div className="flex gap-2">
        {a.canUndo && (
          <button type="button" onClick={log.undo} disabled={log.busy !== null} className={`${primary} flex-1`} style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
            <Undo2 size={14} /> {log.busy === 'undo' ? 'Undoing…' : `Undo${log.countdown ? ` (${log.countdown})` : ''}`}
          </button>
        )}
        <button type="button" onClick={log.reset} className={`${primary} flex-1`} style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}>
          Log another
        </button>
      </div>
    );
    line = log.error ?? `${resultTitle(a)} · ${a.label} · ${formatTime(a.createdAt, timezone)} by ${a.userName}${a.state === 'partial' ? ' — Retry the failing step above' : ''}`;
    lineColor = log.error ? 'var(--danger)' : a.state === 'partial' || a.state === 'failed' ? 'var(--danger)' : 'var(--text-tertiary)';
  }
  return (
    <footer className="shrink-0 px-3 pt-2 pb-2.5" style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-canvas)' }}>
      {controls}
      <p className="mt-1.5 text-[11.5px] leading-snug truncate" data-testid="log-line" title={line} style={{ color: lineColor }}>
        {line}
      </p>
    </footer>
  );
};
