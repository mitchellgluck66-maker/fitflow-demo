'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  FileText,
  Download,
  Send,
  CalendarRange,
  DollarSign,
  Users,
  Trophy,
  BarChart3,
  ArrowRight,
} from 'lucide-react';
import {
  Card,
  CardHeader,
  Button,
  Badge,
  KPITile,
  Toast,
  Modal,
  Input,
  PageHeader,
  PageBody,
  SampleDataBanner,
  PageLoader,
  EmptyState,
} from '@/components';
import { ChartTooltip, CATEGORICAL } from '@/components/Chart';

interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  stage: string;
  source: string | null;
  estimatedValue: number | null;
  owner: string | null;
  createdAt: string;
}

const STAGES = [
  'Applied',
  'Consult Booked',
  'Consult No Show',
  'Pre-Roadmap Booked',
  'Roadmap No Show',
  'Roadmap Completed: Objection',
  'Enrolled',
];

const RANGES = [
  { value: 'week', label: 'This week', days: 7 },
  { value: 'month', label: 'This month', days: 30 },
  { value: 'all', label: 'All time', days: 3650 },
] as const;

export default function ReportsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<'week' | 'month' | 'all'>('month');
  const [exportOpen, setExportOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    detail?: string;
    type: 'success' | 'error' | 'info';
  } | null>(null);

  useEffect(() => {
    fetch('/api/leads')
      .then((r) => r.json())
      .then((d) => setLeads(Array.isArray(d) ? d : []))
      .catch(() => setToast({ message: 'Could not load report data', type: 'error' }))
      .finally(() => setLoading(false));
  }, []);

  const openExport = useCallback(async () => {
    setExportOpen(true);
    try {
      const res = await fetch('/api/export/day-summary');
      const data = await res.json();
      setEmail(data.rememberedEmail ?? '');
    } catch {
      /* dialog still works */
    }
  }, []);

  const send = async () => {
    if (!email.trim()) return;
    setSending(true);
    try {
      const res = await fetch('/api/export/day-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      setToast({
        message: data.sent ? 'Report sent' : 'Could not send',
        detail: data.message,
        type: data.sent ? 'success' : 'error',
      });
      if (data.sent) setExportOpen(false);
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title="Reports" description="Pipeline snapshot and exports" />
        <PageBody>
          <PageLoader />
        </PageBody>
      </>
    );
  }

  const cutoff = Date.now() - (RANGES.find((r) => r.value === range)?.days ?? 30) * 86_400_000;
  const scoped = leads.filter((l) => new Date(l.createdAt).getTime() >= cutoff);

  const stageData = STAGES.map((stage) => {
    const inStage = scoped.filter((l) => l.stage === stage);
    return {
      stage: stage.length > 16 ? `${stage.slice(0, 15)}…` : stage,
      fullStage: stage,
      count: inStage.length,
      value: inStage.reduce((s, l) => s + (l.estimatedValue ?? 0), 0) / 100,
    };
  });

  const sourceMap = new Map<string, { count: number; value: number }>();
  for (const lead of scoped) {
    const key = lead.source ?? 'Unknown';
    const prev = sourceMap.get(key) ?? { count: 0, value: 0 };
    sourceMap.set(key, {
      count: prev.count + 1,
      value: prev.value + (lead.estimatedValue ?? 0),
    });
  }

  const sourceData = Array.from(sourceMap.entries())
    .map(([source, v]) => ({ source, count: v.count, value: v.value / 100 }))
    .sort((a, b) => b.count - a.count);

  const enrolled = scoped.filter((l) => l.stage === 'Enrolled');
  const totalValue = scoped.reduce((s, l) => s + (l.estimatedValue ?? 0), 0);
  const wonValue = enrolled.reduce((s, l) => s + (l.estimatedValue ?? 0), 0);
  const conversion = scoped.length
    ? Math.round((enrolled.length / scoped.length) * 100)
    : 0;

  return (
    <>
      <PageHeader
        title="Reports"
        description="Pipeline snapshot, source breakdown and exports."
        actions={
          <>
            <a href="/api/export/day-summary?format=csv">
              <Button icon={Download}>Export CSV</Button>
            </a>
            <Button variant="primary" icon={Send} onClick={openExport}>
              Email report
            </Button>
          </>
        }
      >
        <div
          className="flex items-center gap-0.5 p-0.5 rounded-[8px] w-fit"
          style={{
            background: 'var(--surface-sunken)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          {RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className="h-[26px] px-3 rounded-[6px] text-[12px] font-medium transition-all duration-150"
              style={
                range === r.value
                  ? {
                      background: 'var(--surface)',
                      color: 'var(--text-primary)',
                      boxShadow: 'var(--shadow-xs)',
                    }
                  : { color: 'var(--text-tertiary)' }
              }
            >
              {r.label}
            </button>
          ))}
        </div>
      </PageHeader>

      <PageBody className="space-y-5">
        <SampleDataBanner page="figures" />
        {/* Pointer to the deeper analysis */}
        <Link href="/metrics">
          <Card
            padding="md"
            hover
            className="flex items-center justify-between gap-4"
          >
            <div className="flex items-center gap-3">
              <div
                className="h-8 w-8 grid place-items-center rounded-[8px]"
                style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
              >
                <BarChart3 size={16} strokeWidth={2.2} />
              </div>
              <div>
                <div
                  className="text-[13.5px] font-semibold"
                  style={{ color: 'var(--text-primary)' }}
                >
                  Looking for trends and conversion analysis?
                </div>
                <div className="text-[12px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  The Metrics tab breaks down show rate, rebook rate and source
                  effectiveness over time.
                </div>
              </div>
            </div>
            <ArrowRight size={15} style={{ color: 'var(--text-quaternary)' }} />
          </Card>
        </Link>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 stagger">
          <KPITile
            label="Leads"
            value={scoped.length}
            subtext={RANGES.find((r) => r.value === range)?.label}
            icon={Users}
            accent="info"
          />
          <KPITile
            label="Pipeline Value"
            value={`$${(totalValue / 100).toLocaleString()}`}
            subtext="Total estimated"
            icon={DollarSign}
            accent="accent"
          />
          <KPITile
            label="Enrolled"
            value={enrolled.length}
            subtext={`$${(wonValue / 100).toLocaleString()} won`}
            icon={Trophy}
            accent="success"
          />
          <KPITile
            label="Conversion"
            value={`${conversion}%`}
            subtext="Applied → Enrolled"
            icon={CalendarRange}
            accent="warning"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
          <Card padding="lg" className="lg:col-span-3">
            <CardHeader
              title="Leads by stage"
              subtitle="Current pipeline distribution"
              icon={BarChart3}
            />

            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={stageData} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="stage"
                  tickLine={false}
                  axisLine={false}
                  interval={0}
                  angle={-25}
                  textAnchor="end"
                  height={62}
                />
                <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ fill: 'var(--surface-hover)' }}
                />
                <Bar dataKey="count" name="Leads" radius={[5, 5, 0, 0]} maxBarSize={46}>
                  {stageData.map((entry, i) => (
                    <Cell
                      key={entry.fullStage}
                      fill={
                        entry.fullStage === 'Enrolled'
                          ? 'var(--success)'
                          : entry.fullStage.includes('No Show')
                            ? 'var(--warning)'
                            : entry.fullStage.includes('Objection')
                              ? 'var(--danger)'
                              : CATEGORICAL[i % CATEGORICAL.length]
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <Card padding="lg" className="lg:col-span-2">
            <CardHeader title="Lead sources" subtitle="Share of volume" icon={FileText} />

            {sourceData.length === 0 ? (
              <EmptyState title="No leads in this range" />
            ) : (
              <>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={sourceData}
                      dataKey="count"
                      nameKey="source"
                      innerRadius={44}
                      outerRadius={74}
                      paddingAngle={2.5}
                      stroke="var(--surface)"
                      strokeWidth={2}
                    >
                      {sourceData.map((entry, i) => (
                        <Cell key={entry.source} fill={CATEGORICAL[i % CATEGORICAL.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                  </PieChart>
                </ResponsiveContainer>

                <div className="flex flex-col gap-1.5 mt-3">
                  {sourceData.slice(0, 5).map((s, i) => (
                    <div key={s.source} className="flex items-center gap-2">
                      <span
                        className="rounded-[2px] shrink-0"
                        style={{
                          width: 8,
                          height: 8,
                          background: CATEGORICAL[i % CATEGORICAL.length],
                        }}
                      />
                      <span
                        className="text-[12px] flex-1 truncate"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {s.source}
                      </span>
                      <span
                        className="text-[12px] font-semibold tabular"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {s.count}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>
        </div>

        {/* Revenue by source */}
        <Card padding="lg">
          <CardHeader
            title="Estimated value by source"
            subtitle="Where the pipeline value sits"
            icon={DollarSign}
          />

          {sourceData.length === 0 ? (
            <EmptyState title="No data in this range" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px]">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    {['Source', 'Leads', 'Share', 'Est. value', 'Avg. value'].map((h, i) => (
                      <th
                        key={h}
                        className={`pb-2.5 text-[11px] font-semibold uppercase tracking-[0.05em] ${i === 0 ? 'text-left' : 'text-right'}`}
                        style={{ color: 'var(--text-quaternary)' }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sourceData.map((s, i) => (
                    <tr
                      key={s.source}
                      className="transition-colors hover:bg-[var(--surface-hover)]"
                      style={{ borderBottom: '1px solid var(--border-subtle)' }}
                    >
                      <td className="py-2.5">
                        <div className="flex items-center gap-2">
                          <span
                            className="rounded-[3px] shrink-0"
                            style={{
                              width: 8,
                              height: 8,
                              background: CATEGORICAL[i % CATEGORICAL.length],
                            }}
                          />
                          <span
                            className="text-[13px] font-medium"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            {s.source}
                          </span>
                        </div>
                      </td>
                      <td
                        className="py-2.5 text-right text-[13px] tabular"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {s.count}
                      </td>
                      <td className="py-2.5 text-right">
                        <Badge variant="neutral" size="xs">
                          {Math.round((s.count / scoped.length) * 100)}%
                        </Badge>
                      </td>
                      <td
                        className="py-2.5 text-right text-[13px] font-semibold tabular"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        ${s.value.toLocaleString()}
                      </td>
                      <td
                        className="py-2.5 text-right text-[12.5px] tabular"
                        style={{ color: 'var(--text-tertiary)' }}
                      >
                        ${Math.round(s.value / Math.max(s.count, 1)).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </PageBody>

      <Modal
        isOpen={exportOpen}
        onClose={() => setExportOpen(false)}
        title="Email report"
        description="Send today's summary to a recipient."
        actions={
          <>
            <Button variant="ghost" onClick={() => setExportOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={Send}
              loading={sending}
              disabled={!email.trim()}
              onClick={send}
            >
              Send
            </Button>
          </>
        }
      >
        <Input
          label="Send to"
          type="email"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          hint="Remembered for next time."
        />
      </Modal>

      {toast && (
        <Toast
          message={toast.message}
          detail={toast.detail}
          type={toast.type}
          isVisible={!!toast}
          onClose={() => setToast(null)}
        />
      )}
    </>
  );
}
