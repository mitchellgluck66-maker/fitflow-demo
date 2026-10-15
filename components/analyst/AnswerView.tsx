'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SECTION_LABELS } from '@/lib/analyst/schema';
import type { TurnView } from '@/lib/analyst/clientState';
import { usageLine } from '@/lib/analyst/clientState';
import { wordFade } from './wordFade';

const label = (key: string) => (SECTION_LABELS as Record<string, string>)[key] ?? key.replace(/_/g, ' ');

/** One section's markdown, revealed word by word (the demo's `.w` spans; inert under reduced motion). */
function Body({ md, fade }: { md: string; fade: boolean }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={fade ? [wordFade] : []} skipHtml>
      {md}
    </ReactMarkdown>
  );
}

/** The formula box of an explain turn: the glossary's formula and the worked numbers, computed by the server. */
export function FormulaBox({ explain }: { explain: NonNullable<TurnView['explain']> }) {
  return (
    <div className="analyst-formula" data-testid="analyst-formula">
      <code>{explain.formula}</code>
      <br />
      {explain.value === null && explain.reason ? <span>Withheld: {explain.reason}</span> : <span>{explain.worked}</span>}
      {explain.maturing ? <div className="analyst-formula-note">History-dependent: maturing before the history-complete date.</div> : null}
    </div>
  );
}

const CONFIDENCE: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };

/** The rendered answer (headline, sections with labels, actions table, findings, note proposals) — or the sections streamed so far. */
export function AnswerView({ turn, onApproveNote, onRejectNote }: { turn: TurnView; onApproveNote?: (text: string) => void; onRejectNote?: (text: string) => void }) {
  const [decided, setDecided] = useState<Record<string, 'active' | 'rejected'>>({});
  // Sections that arrived while streaming keep their fade; the final answer re-renders the same text without re-fading.
  const [fadedKeys, setFadedKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    setFadedKeys((prev) => {
      const next = new Set(prev);
      for (const s of turn.sections) next.add(s.key);
      return next;
    });
  }, [turn.sections]);
  const a = turn.answer;
  const sections = turn.sections;
  if (!a && sections.length === 0 && !turn.explain) return null;
  return (
    <div className="analyst-msg analyst-msg-ai" data-testid="analyst-answer" data-status={turn.status}>
      {a?.kind === 'clarify' ? (
        <>
          <p className="analyst-headline">{a.headline}</p>
          <p>{a.clarifying_question}</p>
        </>
      ) : (
        <>
          {a ? <p className="analyst-headline">{a.headline}</p> : null}
          {turn.explain ? <FormulaBox explain={turn.explain} /> : null}
          {sections.map((s) => (
            <section key={s.key} data-section={s.key} data-verified={s.verified ? 'true' : 'false'}>
              <h4>{label(s.key)}</h4>
              <Body md={s.body_md} fade={!fadedKeys.has(s.key) || turn.status === 'running'} />
            </section>
          ))}
        </>
      )}
      {a && a.actions.length > 0 ? (
        <>
          <h4>Actions</h4>
          <table className="analyst-actions-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Impact</th>
                <th>Confidence</th>
                <th>Check</th>
              </tr>
            </thead>
            <tbody>
              {a.actions.map((x, i) => (
                <tr key={i} data-gate={x.gate ?? undefined}>
                  <td>
                    {x.action}
                    {x.gate ? <span className="analyst-gate">{x.gate === 'hold' ? 'gate: hold' : 'gate: may change'}{x.decidedBy === 'server' ? ' · server' : ''}</span> : null}
                    {x.why ? <div className="analyst-why">{x.why}</div> : null}
                  </td>
                  <td>{x.expected_impact || '—'}</td>
                  <td>{CONFIDENCE[x.confidence] ?? x.confidence}</td>
                  <td>{x.check_date || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {a && a.findings.length > 0 ? (
        <div className="analyst-cites">
          {a.findings.map((f, i) => (
            <span key={i} className="analyst-cite" title={f.evidence_refs.join(', ')}>
              {f.area} · <em>{f.finding}</em>
            </span>
          ))}
        </div>
      ) : null}
      {a && a.note_proposals.length > 0 ? (
        <div className="analyst-proposals">
          <h4>Remember this?</h4>
          {a.note_proposals.map((n) => (
            <div key={n} className="analyst-proposal">
              <span>{n}</span>
              {decided[n] ? (
                <em>{decided[n] === 'active' ? 'Saved to your notes' : 'Dismissed'}</em>
              ) : (
                <span className="analyst-proposal-actions">
                  <button type="button" onClick={() => { setDecided((d) => ({ ...d, [n]: 'active' })); onApproveNote?.(n); }}>Save</button>
                  <button type="button" onClick={() => { setDecided((d) => ({ ...d, [n]: 'rejected' })); onRejectNote?.(n); }}>Dismiss</button>
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {turn.usage ? (
        <div className="analyst-usage">
          {usageLine(turn.usage)}
          {turn.flagged ? ` · ${turn.flagged} not verified` : ''}
          {turn.repaired ? ' · repaired once' : ''}
          {a?.note_proposals.length ? (
            <>
              {' · '}
              <Link href="/setup#analyst">notes in Setup</Link>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
