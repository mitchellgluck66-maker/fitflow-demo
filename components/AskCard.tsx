'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { MessageSquareText, ArrowRight, Send, History, X } from 'lucide-react';
import { Card, CardHeader, Button, Badge } from '@/components';
import { formatCents } from '@/lib/metrics';

interface Citation {
  label: string;
  value: number;
  path: string;
}
interface QA {
  id: string | null;
  question: string;
  answer: string;
  citations: Citation[];
  period: { start: string; end: string; label: string } | null;
  model: string | null;
  generatedAt: string | null;
}

const SUGGESTIONS = ['What changed since last week?', 'Where should we put more money?', 'Which campaign has the best cost per client?', 'Why is Paid CAC different from Blended CAC?'];

/** Render a citation value the way the prompt told the model to (cents → $, ratio → %, multiples → ×). */
function fmtCitation(c: Citation): string {
  const p = c.path.toLowerCase();
  if (p.endsWith('cents')) return formatCents(c.value);
  if (/roas|ltvtocac|frequency/.test(p)) return `${c.value.toFixed(2)}×`;
  if (/rate|share|conversion|pct|changepct/.test(p) && Math.abs(c.value) <= 1) return `${(c.value * 100).toFixed(0)}%`;
  return Number.isInteger(c.value) ? c.value.toLocaleString() : String(c.value);
}

/**
 * Command Center "Ask" card: the CEO types a question, the server answers
 * from the same structured metrics the insight cards use, and the citations
 * chips show exactly which numbers the answer leaned on. History opens in a
 * slide-over drawer. Without a key: the connect state.
 */
export const AskCard: React.FC = () => {
  const params = useSearchParams();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [history, setHistory] = useState<QA[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<QA | null>(null);
  const [drawer, setDrawer] = useState(false);

  const load = useCallback(() => {
    return fetch('/api/anthropic/ask?limit=25')
      .then((r) => r.json())
      .then((d: { configured: boolean; history: QA[] }) => {
        setConfigured(Boolean(d.configured));
        setHistory(d.history ?? []);
        setLatest((prev) => prev ?? d.history?.[0] ?? null);
      })
      .catch(() => setConfigured(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const ask = async (q?: string) => {
    const text = (q ?? question).trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { question: text };
      for (const k of ['range', 'start', 'end', 'compare']) {
        const v = params.get(k);
        if (v) body[k] = v;
      }
      const res = await fetch('/api/anthropic/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        setError(d.error ?? d.detail ?? 'Could not answer');
        return;
      }
      const qa: QA = { id: d.reportId, question: d.question, answer: d.answer, citations: d.citations ?? [], period: d.period, model: d.model, generatedAt: d.generatedAt };
      setLatest(qa);
      setHistory((h) => [qa, ...h]);
      setQuestion('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (configured === null) return null;

  if (!configured) {
    return (
      <div className="flex flex-wrap items-center gap-3 px-3.5 py-2.5 rounded-[10px]" style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}>
        <MessageSquareText size={14} strokeWidth={2.2} style={{ color: 'var(--text-quaternary)' }} />
        <span className="text-[12.5px] flex-1 min-w-[200px]" style={{ color: 'var(--text-tertiary)' }}>
          Connect Anthropic to ask the dashboard questions — answers cite only the numbers on this page.
        </span>
        <Link href="/setup">
          <Button variant="ghost" iconRight={ArrowRight}>
            Connect Anthropic
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <>
      <Card padding="lg">
        <CardHeader
          title="Ask the dashboard"
          subtitle="Answers use only the numbers in the selected period, its comparison, the trailing 8 weeks and the campaign table."
          icon={MessageSquareText}
          action={
            <Button variant="ghost" icon={History} onClick={() => setDrawer(true)} disabled={history.length === 0}>
              History{history.length ? ` (${history.length})` : ''}
            </Button>
          }
        />

        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What changed since last week? Where should we put more money?"
            maxLength={500}
            className="flex-1 h-9 px-3 text-[13px] rounded-[8px] focus-ring"
            style={{ background: 'var(--surface)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
            aria-label="Question"
            disabled={busy}
          />
          <Button type="submit" variant="primary" icon={Send} loading={busy} disabled={!question.trim()}>
            Ask
          </Button>
        </form>

        {!latest && !busy && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void ask(s)}
                className="text-[12px] px-2.5 h-7 rounded-full transition-colors focus-ring hover:bg-[var(--surface-hover)]"
                style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {error && (
          <p className="text-[12.5px] mt-3" role="alert" style={{ color: 'var(--negative-text, var(--danger))' }}>
            {error}
          </p>
        )}

        {latest && (
          <div className="mt-4">
            <div className="text-[12px] font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>
              Q · {latest.question}
              {latest.period ? <span style={{ color: 'var(--text-quaternary)' }}> · {latest.period.label}</span> : null}
            </div>
            <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
              {latest.answer}
            </p>
            {latest.citations.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {latest.citations.map((c, i) => (
                  <span key={i} title={c.path}>
                    <Badge variant="neutral" size="xs">
                      {c.label}: {fmtCitation(c)}
                    </Badge>
                  </span>
                ))}
              </div>
            )}
            <p className="text-[11px] mt-2" style={{ color: 'var(--text-quaternary)' }}>
              Every number above was checked against the dashboard data before it was saved
              {latest.generatedAt ? ` · ${new Date(latest.generatedAt).toLocaleString()}` : ''}
              {latest.model ? ` · ${latest.model}` : ''}
            </p>
          </div>
        )}
      </Card>

      {drawer && (
        <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="Question history">
          <button type="button" className="flex-1" style={{ background: 'rgba(0,0,0,0.35)' }} onClick={() => setDrawer(false)} aria-label="Close history" />
          <aside className="w-full max-w-[520px] h-full overflow-y-auto surface-raised p-5 space-y-4" style={{ borderLeft: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center justify-between">
              <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                Questions asked
              </div>
              <Button variant="ghost" icon={X} onClick={() => setDrawer(false)} aria-label="Close" />
            </div>
            {history.map((qa) => (
              <button
                key={qa.id ?? qa.generatedAt ?? qa.question}
                type="button"
                onClick={() => {
                  setLatest(qa);
                  setDrawer(false);
                }}
                className="w-full text-left rounded-[10px] px-3 py-2.5 transition-colors hover:bg-[var(--surface-hover)] focus-ring"
                style={{ border: '1px solid var(--border-subtle)' }}
              >
                <div className="text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  {qa.question}
                </div>
                <div className="text-[12px] mt-1 line-clamp-3" style={{ color: 'var(--text-secondary)' }}>
                  {qa.answer}
                </div>
                <div className="text-[11px] mt-1" style={{ color: 'var(--text-quaternary)' }}>
                  {qa.period?.label ?? ''}
                  {qa.generatedAt ? ` · ${new Date(qa.generatedAt).toLocaleString()}` : ''}
                </div>
              </button>
            ))}
          </aside>
        </div>
      )}
    </>
  );
};
