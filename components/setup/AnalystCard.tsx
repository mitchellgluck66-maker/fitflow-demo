'use client';

import React, { useEffect, useState } from 'react';
import { BrainCircuit, CheckCircle2, XCircle, RefreshCw, Plus, Check, X, Trash2 } from 'lucide-react';
import { AccordionCard, Badge, Button, Input, Select, Toast } from '@/components';
import { fetchJson } from '@/lib/clientFetch';

interface AnalystSettings {
  configured: boolean;
  modelDefault: string;
  modelDeep: string;
  modelOptions: string[];
  effort: string;
  answerMode: 'format' | 'submit_answer';
  capRunUsd: number;
  capMonthUsd: number;
  spentMonthUsd: number;
  brief: { built: boolean; summary: string; tokens: number | null; dataThrough: string | null; builtAt: string | null };
  gaps: Array<{ field: string; label: string; withheld: string }>;
  withheld: string | null;
}

interface Offer {
  name: string;
  priceCents: number;
  currency: 'CAD' | 'USD';
}
interface Profile {
  goals: string;
  offers: Offer[];
  grossMarginPct: number | null;
  targetCacCents: number | null;
  monthlyRevenueTargetCents: number | null;
  team: string;
  goodWeek: string;
}
interface Note {
  id: string;
  text: string;
  status: 'active' | 'proposed' | 'rejected';
  source: 'owner' | 'analyst';
  createdAt: string;
}

const usd = (n: number) => `$${n.toFixed(2)} USD`;
const dollars = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2));
const cents = (s: string) => (s.trim() === '' ? null : Math.round(Number(s) * 100));

/**
 * Setup → Analyst (plan item 8): models, caps, the owner profile with its
 * gaps checklist (amendment 4), notes (approve / reject the Analyst's
 * proposals), the brief with Rebuild, month-to-date spend (USD), and Verify —
 * a real streamed tool turn, the same path the feature uses.
 */
export const AnalystCard: React.FC = () => {
  const [s, setS] = useState<AnalystSettings | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [newNote, setNewNote] = useState('');
  const [verified, setVerified] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; detail?: string; type: 'success' | 'error' | 'info' } | null>(null);

  const load = async () => {
    try {
      const [settings, n] = await Promise.all([fetchJson<AnalystSettings>('/api/analyst/settings'), fetchJson<{ notes: Note[]; profile: Profile }>('/api/analyst/notes')]);
      setS(settings);
      setNotes(n.notes);
      setProfile(n.profile);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const post = async (label: string, url: string, init: RequestInit, onOk?: (d: Record<string, unknown>) => void) => {
    setBusy(label);
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
      const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || d.ok === false) setToast({ message: `${label} failed`, detail: String(d.error ?? d.message ?? res.statusText), type: 'error' });
      else onOk?.(d);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = (patch: Record<string, unknown>) => post('Save', '/api/analyst/settings', { method: 'POST', body: JSON.stringify(patch) }, () => setToast({ message: 'Analyst settings saved', type: 'success' }));
  const saveProfile = () => profile && post('Save profile', '/api/analyst/profile', { method: 'PUT', body: JSON.stringify({ profile }) }, (d) => setToast({ message: 'Owner profile saved', detail: d.rebuilt ? 'Brief rebuilt' : String(d.error ?? ''), type: d.rebuilt ? 'success' : 'info' }));
  const rebuild = () => post('Rebuild', '/api/analyst/brief', { method: 'POST' }, (d) => setToast({ message: 'Brief rebuilt', detail: String(d.reason ?? ''), type: 'success' }));
  const addNote = () => newNote.trim() && post('Add note', '/api/analyst/notes', { method: 'POST', body: JSON.stringify({ text: newNote }) }, () => setNewNote(''));
  const decide = (id: string, decision: 'active' | 'rejected') => post(decision === 'active' ? 'Approve' : 'Reject', '/api/analyst/notes', { method: 'PATCH', body: JSON.stringify({ id, decision }) });
  const remove = (id: string) => post('Delete', '/api/analyst/notes', { method: 'DELETE', body: JSON.stringify({ id }) });
  const verify = async (model: string) => {
    setBusy(`verify:${model}`);
    try {
      const res = await fetch('/api/analyst/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      setVerified({ ok: Boolean(d.ok), message: d.message ?? 'No message returned' });
      setToast({ message: d.ok ? 'Analyst verified' : 'Verification failed', detail: d.message, type: d.ok ? 'success' : 'error' });
    } finally {
      setBusy(null);
    }
  };

  const summary = !s ? (error ? 'Could not load' : 'Loading…') : !s.configured ? 'Needs the Anthropic key' : !s.brief.built ? 'Brief not built' : verified ? (verified.ok ? 'Verified' : 'Verification failed') : `${s.modelDefault} · ${usd(s.spentMonthUsd)} this month`;
  const proposed = notes.filter((n) => n.status === 'proposed');

  return (
    <AccordionCard
      title="Analyst"
      summary={summary}
      subtitle="The CMO + CFO advisor: models, cost caps, the owner profile and notes it reads, its business brief, and a live verification"
      icon={BrainCircuit}
      defaultOpen={Boolean(s && (!s.brief.built || proposed.length > 0 || (verified && !verified.ok)))}
      action={<Badge variant={!s?.configured ? 'neutral' : verified ? (verified.ok ? 'success' : 'warning') : s.brief.built ? 'success' : 'warning'} dot>{!s?.configured ? 'Not connected' : verified ? (verified.ok ? 'Verified' : 'Failed') : s.brief.built ? 'Ready' : 'Brief needed'}</Badge>}
    >
      {error && (
        <p className="text-[12.5px] mb-3" style={{ color: 'var(--negative-text)' }}>
          {error}
        </p>
      )}
      {verified && (
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-[8px] mb-4" style={{ background: verified.ok ? 'var(--success-muted)' : 'var(--warning-muted)', border: `1px solid ${verified.ok ? 'var(--success-border)' : 'var(--warning-border)'}` }}>
          {verified.ok ? <CheckCircle2 size={14} strokeWidth={2.3} style={{ color: 'var(--success)', marginTop: 2 }} /> : <XCircle size={14} strokeWidth={2.3} style={{ color: 'var(--warning)', marginTop: 2 }} />}
          <span className="text-[12.5px]" style={{ color: verified.ok ? 'var(--success)' : 'var(--warning)' }}>
            {verified.message}
          </span>
        </div>
      )}

      {/* Brief */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-[12.5px]" style={{ color: s?.brief.built ? 'var(--text-secondary)' : 'var(--warning)' }}>
          {s?.brief.summary ?? '…'}
        </span>
        <div className="flex-1" />
        <Button icon={RefreshCw} loading={busy === 'Rebuild'} disabled={!s} onClick={rebuild}>
          {s?.brief.built ? 'Rebuild now' : 'Build now'}
        </Button>
      </div>

      {/* Models, effort, caps */}
      {s && (
        <div className="grid gap-3 md:grid-cols-2 mb-4">
          <Select label="Default model" value={s.modelDefault} onChange={(e) => saveSettings({ modelDefault: e.target.value })} hint="Chat, explain and the weekly review.">
            {s.modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
          <Select label="Deep analysis model" value={s.modelDeep} onChange={(e) => saveSettings({ modelDeep: e.target.value })} hint="Full reports. Fable 5.1 needs 30-day data retention on the Anthropic org.">
            {s.modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
          <Select label="Effort" value={s.effort} onChange={(e) => saveSettings({ effort: e.target.value })} hint="Adaptive thinking; fixed per thread.">
            {['low', 'medium', 'high', 'xhigh', 'max'].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
          <Select label="Answer mode" value={s.answerMode} onChange={(e) => saveSettings({ answerMode: e.target.value })} hint="Decided by npm run smoke:analyst -- --probe: output_config.format, or the strict submit_answer fallback.">
            <option value="format">output_config.format</option>
            <option value="submit_answer">submit_answer tool (fallback)</option>
          </Select>
          <Input label="Per-run cap (USD)" type="number" min={0} step={0.5} defaultValue={s.capRunUsd} onBlur={(e) => Number(e.target.value) !== s.capRunUsd && saveSettings({ capRunUsd: Number(e.target.value) })} hint="Above this the Analyst asks before spending." />
          <Input label="Monthly budget (USD)" type="number" min={0} step={10} defaultValue={s.capMonthUsd} onBlur={(e) => Number(e.target.value) !== s.capMonthUsd && saveSettings({ capMonthUsd: Number(e.target.value) })} hint={`Spent this month: ${usd(s.spentMonthUsd)}`} />
        </div>
      )}

      {/* Verify */}
      {s && (
        <div className="flex flex-wrap items-center gap-2 mb-5">
          {[s.modelDefault, ...(s.modelDeep !== s.modelDefault ? [s.modelDeep] : [])].map((m) => (
            <Button key={m} variant="primary" loading={busy === `verify:${m}`} disabled={!s.configured || !s.brief.built} onClick={() => verify(m)}>
              Verify {m}
            </Button>
          ))}
          <span className="text-[11.5px]" style={{ color: 'var(--text-quaternary)' }}>
            Runs a real streamed tool turn on the model — the same path the Analyst uses. Nothing is stored.
          </span>
        </div>
      )}

      {/* Owner profile */}
      {profile && (
        <div className="mb-5">
          <div className="text-[12.5px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
            Owner profile
          </div>
          {s?.withheld && (
            <div className="text-[12px] mb-2 px-3 py-2 rounded-[8px]" style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)', color: 'var(--warning)' }} data-testid="analyst-gaps">
              <strong>{s.withheld}</strong>
              <ul className="mt-1 list-disc pl-4">
                {s.gaps.map((g) => (
                  <li key={g.field}>
                    {g.label} → {g.withheld}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <Input label="Goals" value={profile.goals} onChange={(e) => setProfile({ ...profile, goals: e.target.value })} placeholder="e.g. 20 new clients a month at under $1,000 CAD Paid CAC" />
            <Input label="Team" value={profile.team} onChange={(e) => setProfile({ ...profile, team: e.target.value })} placeholder="Who does what (names and roles)" />
            <Input label="Gross margin (%)" type="number" min={0} max={100} value={profile.grossMarginPct ?? ''} onChange={(e) => setProfile({ ...profile, grossMarginPct: e.target.value === '' ? null : Number(e.target.value) })} hint="Unlocks CAC payback." />
            <Input label="Monthly revenue target (CAD)" type="number" min={0} value={dollars(profile.monthlyRevenueTargetCents)} onChange={(e) => setProfile({ ...profile, monthlyRevenueTargetCents: cents(e.target.value) })} hint="Unlocks pace to target." />
            <Input label="Target CAC (CAD)" type="number" min={0} value={dollars(profile.targetCacCents)} onChange={(e) => setProfile({ ...profile, targetCacCents: cents(e.target.value) })} />
            <Input label="What a good week looks like" value={profile.goodWeek} onChange={(e) => setProfile({ ...profile, goodWeek: e.target.value })} placeholder="e.g. 60 applied, 12 consults, 5 enrolled" />
          </div>
          <div className="mt-3">
            <div className="text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Offers (unlock funnel-leak $)
            </div>
            {profile.offers.map((o, i) => (
              <div key={i} className="flex items-center gap-2 mb-2">
                <Input value={o.name} placeholder="Offer name" onChange={(e) => setProfile({ ...profile, offers: profile.offers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                <Input type="number" min={0} value={dollars(o.priceCents)} placeholder="Price" onChange={(e) => setProfile({ ...profile, offers: profile.offers.map((x, j) => (j === i ? { ...x, priceCents: cents(e.target.value) ?? 0 } : x)) })} />
                <Select value={o.currency} onChange={(e) => setProfile({ ...profile, offers: profile.offers.map((x, j) => (j === i ? { ...x, currency: e.target.value as 'CAD' | 'USD' } : x)) })}>
                  <option value="CAD">CAD</option>
                  <option value="USD">USD</option>
                </Select>
                <Button variant="ghost" icon={Trash2} onClick={() => setProfile({ ...profile, offers: profile.offers.filter((_, j) => j !== i) })} aria-label="Remove offer" />
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Button icon={Plus} onClick={() => setProfile({ ...profile, offers: [...profile.offers, { name: '', priceCents: 0, currency: 'CAD' }] })}>
                Add offer
              </Button>
              <div className="flex-1" />
              <Button variant="primary" loading={busy === 'Save profile'} onClick={saveProfile}>
                Save profile
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Notes */}
      <div>
        <div className="text-[12.5px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
          Owner notes {proposed.length > 0 && <Badge variant="warning" size="xs">{proposed.length} proposed by the Analyst</Badge>}
        </div>
        <div className="flex items-center gap-2 mb-2">
          <Input value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="e.g. Paused the Retargeting campaign on Oct 3" onKeyDown={(e) => e.key === 'Enter' && addNote()} />
          <Button icon={Plus} loading={busy === 'Add note'} disabled={!newNote.trim()} onClick={addNote}>
            Add
          </Button>
        </div>
        {notes.length === 0 && (
          <p className="text-[12px]" style={{ color: 'var(--text-quaternary)' }}>
            No notes yet. Dated facts the Analyst should always know: price changes, paused campaigns, team changes.
          </p>
        )}
        <ul className="space-y-1.5">
          {notes
            .filter((n) => n.status !== 'rejected')
            .map((n) => (
              <li key={n.id} className="flex items-start gap-2 text-[12.5px]" style={{ color: 'var(--text-primary)' }}>
                <span style={{ color: 'var(--text-quaternary)', fontFamily: 'var(--font-jetbrains)' }}>{n.createdAt.slice(0, 10)}</span>
                <span className="flex-1">
                  {n.text} {n.status === 'proposed' && <Badge variant="warning" size="xs">proposed</Badge>}
                </span>
                {n.status === 'proposed' ? (
                  <>
                    <Button variant="ghost" icon={Check} loading={busy === 'Approve'} onClick={() => decide(n.id, 'active')}>
                      Approve
                    </Button>
                    <Button variant="ghost" icon={X} loading={busy === 'Reject'} onClick={() => decide(n.id, 'rejected')}>
                      Reject
                    </Button>
                  </>
                ) : (
                  <Button variant="ghost" icon={Trash2} loading={busy === 'Delete'} onClick={() => remove(n.id)} aria-label="Delete note" />
                )}
              </li>
            ))}
        </ul>
      </div>

      <Toast isVisible={toast !== null} message={toast?.message ?? ''} detail={toast?.detail} type={toast?.type ?? 'info'} onClose={() => setToast(null)} />
    </AccordionCard>
  );
};
