'use client';

import React, { useCallback, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Menu, Plus, X } from 'lucide-react';
import { FlynnOrb } from './FlynnOrb';
import { useAnalystOptional } from './AnalystProvider';
import { ThinkingState } from './ThinkingState';
import { AnswerView } from './AnswerView';
import { ThreadList } from './ThreadList';
import { Composer } from './Composer';
import { currentStatus, greeting, type TurnView } from '@/lib/analyst/clientState';

/** The demo's five presets. The wide one runs as a chat review until Wave 3's report presets exist. */
const PRESETS: Array<{ key: string; title: string; sub: string; question: string; wide?: boolean }> = [
  { key: 'full', title: 'Run full review', sub: 'Marketing, funnel, sales, revenue and cash, with an actions table', question: 'Run a full review of the last complete week: marketing, funnel, sales, revenue and cash, with an actions table.', wide: true },
  { key: 'funnel', title: 'Funnel leaks', sub: "Where we're losing people, and who to call", question: 'Where are we losing people in the funnel, and who should we call today?' },
  { key: 'ads', title: 'Ad spend', sub: 'Which campaigns to scale, hold or cut', question: 'Which campaigns should we scale, hold or cut?' },
  { key: 'changed', title: 'What changed', sub: 'This period vs normal', question: 'What changed this period vs normal?' },
  { key: 'cash', title: 'Cash & collections', sub: 'Failed payments, refunds, subscriptions', question: 'How are cash and collections looking: failed payments, refunds, subscriptions?' },
];

function modelName(model: string | null | undefined): string {
  if (!model) return 'Claude Opus 5.5';
  return model.includes('fable') ? 'Claude Fable 5.1' : 'Claude Opus 5.5';
}

function Welcome({ onPreset, settings, settingsError, onRebuild }: { onPreset: (q: string) => void; settings: { configured: boolean; briefBuilt: boolean } | null; settingsError: string | null; onRebuild: () => void }) {
  const hour = new Date().getHours();
  const blocked = settings && (!settings.configured || !settings.briefBuilt);
  return (
    <div className="analyst-welcome" data-testid="analyst-welcome">
      <h2>
        {greeting(hour)}
        <br />
        What would you like to know?
      </h2>
      <p>I can read every page of FitFlow, explain any metric, and tell you what&rsquo;s working, what isn&rsquo;t, and what to do next.</p>
      {settingsError ? <p className="analyst-alert">Analyst settings could not be read: {settingsError}</p> : null}
      {settings && !settings.configured ? (
        <p className="analyst-alert">
          <Link href="/setup#analyst">Connect Anthropic in Setup</Link> to start.
        </p>
      ) : null}
      {settings && settings.configured && !settings.briefBuilt ? (
        <p className="analyst-alert">
          The business brief hasn&rsquo;t been built yet ·{' '}
          <button type="button" className="analyst-link" onClick={onRebuild}>
            Build now
          </button>
        </p>
      ) : null}
      <div className="analyst-presets">
        {PRESETS.map((p) => (
          <button key={p.key} type="button" className={`analyst-preset${p.wide ? ' is-wide' : ''}`} onClick={() => onPreset(p.question)} disabled={Boolean(blocked)} data-preset={p.key}>
            <b>{p.title}</b>
            <span>{p.sub}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Confirmation({ turn, onRun, onCancel }: { turn: TurnView; onRun: () => void; onCancel: () => void }) {
  const est = turn.confirmation?.estimateUsd;
  return (
    <div className="analyst-card analyst-confirm" role="alertdialog" aria-label="Cost confirmation" data-testid="analyst-confirm">
      <p>
        {est !== null && est !== undefined ? `This run is estimated at $${est.toFixed(2)} USD, above your cap` : turn.confirmation?.reason ?? 'This run is above your cap'}
        {turn.confirmation?.spentUsd !== null && turn.confirmation?.spentUsd !== undefined ? ` · $${turn.confirmation.spentUsd.toFixed(2)} USD spent so far` : ''}
      </p>
      <div className="analyst-card-actions">
        <button type="button" className="analyst-btn is-primary" onClick={onRun}>
          Run anyway
        </button>
        <button type="button" className="analyst-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function TurnBlock({ turn }: { turn: TurnView }) {
  const a = useAnalystOptional();
  const live = turn.status === 'starting' || turn.status === 'running' || turn.status === 'continue';
  const approve = useCallback(async (text: string, decision: 'active' | 'rejected') => {
    try {
      const r = await fetch('/api/analyst/notes', { cache: 'no-store' });
      const j = (await r.json()) as { notes?: Array<{ id: string; text: string; status: string }> };
      const note = j.notes?.find((n) => n.status === 'proposed' && n.text === text);
      if (note) await fetch('/api/analyst/notes', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: note.id, decision }) });
    } catch {
      /* the Setup page lists proposals too */
    }
  }, []);
  return (
    <div data-testid="analyst-turn" data-status={turn.status}>
      <div className="analyst-msg analyst-msg-user">
        <div>{turn.question}</div>
      </div>
      {turn.notice?.stale ? <div className="analyst-notice">{turn.notice.text}</div> : null}
      {turn.explain && turn.sections.length === 0 && !turn.answer ? (
        <div className="analyst-msg analyst-msg-ai">
          <AnswerView turn={{ ...turn, explain: turn.explain }} />
        </div>
      ) : (
        <AnswerView turn={turn} onApproveNote={(t) => void approve(t, 'active')} onRejectNote={(t) => void approve(t, 'rejected')} />
      )}
      {live ? <ThinkingState status={currentStatus(turn)} /> : null}
      {turn.status === 'needs_confirmation' ? <Confirmation turn={turn} onRun={() => a?.confirm(turn)} onCancel={() => a?.dismissConfirmation(turn)} /> : null}
      {turn.status === 'failed' && turn.error ? (
        <div className="analyst-card analyst-error" role="alert" data-testid="analyst-error">
          <p>{turn.error.message}</p>
          <div className="analyst-card-actions">
            {turn.error.retryable ? (
              <button type="button" className="analyst-btn is-primary" onClick={() => a?.retry(turn)}>
                Retry
              </button>
            ) : (
              <Link href="/setup#analyst" className="analyst-btn is-primary">
                Open Setup
              </Link>
            )}
          </div>
        </div>
      ) : null}
      {turn.status === 'stopped' ? <div className="analyst-muted">Stopped.</div> : null}
    </div>
  );
}

/** The right-side panel (docs/fitflow-analyst-demo.html): header with the orb, context pill, stream, composer. */
export function AnalystPanel() {
  const a = useAnalystOptional();
  const streamRef = useRef<HTMLDivElement>(null);
  const turnsCount = a?.turns.length ?? 0;
  const lastStatus = a?.turns[a.turns.length - 1]?.lastEventIndex ?? 0;
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [turnsCount, lastStatus]);
  if (!a) return null;
  const periodChip = a.pageContext.range?.label?.split(' · ')[1] ?? null;
  return (
    <aside className="analyst-panel" aria-label="FitFlow Analyst" aria-hidden={a.isOpen ? 'false' : 'true'} data-open={a.isOpen ? 'true' : 'false'} data-testid="analyst-panel">
      <div className="analyst-head">
        <FlynnOrb size={30} particles={90} glitch={false} speed={a.busy ? 2.4 : 1} />
        <div>
          <div className="analyst-title">FitFlow Analyst</div>
          <div className="analyst-model">{modelName(a.settings?.modelDefault)} · knows every page and metric</div>
        </div>
        <div className="analyst-actions">
          <button type="button" className="analyst-icon-btn" title="Conversations" aria-label="Conversations" aria-pressed={a.view === 'threads'} onClick={() => a.setView(a.view === 'threads' ? 'chat' : 'threads')}>
            <Menu size={16} strokeWidth={1.7} />
          </button>
          <button type="button" className="analyst-icon-btn" title="New conversation" aria-label="New conversation" onClick={a.newConversation}>
            <Plus size={16} strokeWidth={1.7} />
          </button>
          <button type="button" className="analyst-icon-btn" title="Close (Esc)" aria-label="Close" onClick={a.close}>
            <X size={16} strokeWidth={1.7} />
          </button>
        </div>
      </div>
      <div className={`analyst-ctx${a.freshness?.stale ? ' is-stale' : ''}`} data-testid="analyst-context">
        <i />
        <span>
          {a.contextText}
          {a.freshness ? ` · ${a.freshness.text}` : ''}
        </span>
      </div>
      <div className="analyst-stream" ref={streamRef}>
        {a.view === 'threads' ? (
          <ThreadList />
        ) : a.turns.length === 0 ? (
          <Welcome onPreset={(q) => a.ask(q)} settings={a.settings} settingsError={a.settingsError} onRebuild={() => void a.rebuildBrief()} />
        ) : (
          a.turns.map((t) => <TurnBlock key={t.clientTurnId} turn={t} />)
        )}
      </div>
      <Composer onSend={(q) => a.ask(q)} onStop={a.stop} busy={a.busy} modelChip={modelName(a.settings?.modelDefault).replace('Claude ', '')} periodChip={periodChip} disabled={Boolean(a.settings && (!a.settings.configured || !a.settings.briefBuilt))} autoFocus={a.isOpen} />
    </aside>
  );
}
