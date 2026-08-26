'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Users,
  DollarSign,
  Trophy,
  UserX,
  ArrowRight,
  Search,
  Inbox,
} from 'lucide-react';
import {
  Card,
  Badge,
  Button,
  KPITile,
  Toast,
  PageHeader,
  PageBody,
  SampleDataBanner,
  PageLoader,
  EmptyState,
  Input,
} from '@/components';

interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  stage: string;
  source: string | null;
  appointmentTime: string | null;
  estimatedValue: number | null;
  owner: string | null;
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

const STAGE_VARIANT: Record<
  string,
  'info' | 'accent' | 'warning' | 'danger' | 'success' | 'neutral'
> = {
  Applied: 'info',
  'Consult Booked': 'accent',
  'Consult No Show': 'warning',
  'Pre-Roadmap Booked': 'accent',
  'Roadmap No Show': 'warning',
  'Roadmap Completed: Objection': 'danger',
  Enrolled: 'success',
};

export default function DashboardPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<{
    message: string;
    type: 'success' | 'error' | 'info';
  } | null>(null);

  useEffect(() => {
    fetch('/api/leads')
      .then((r) => r.json())
      .then((data) => setLeads(Array.isArray(data) ? data : []))
      .catch(() => setToast({ message: 'Could not load leads', type: 'error' }))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    let result = selectedStage
      ? leads.filter((l) => l.stage === selectedStage)
      : leads;

    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter(
        (l) =>
          `${l.firstName} ${l.lastName}`.toLowerCase().includes(q) ||
          l.email.toLowerCase().includes(q) ||
          (l.source ?? '').toLowerCase().includes(q),
      );
    }

    return result;
  }, [leads, selectedStage, query]);

  const stats = useMemo(() => {
    const enrolled = leads.filter((l) => l.stage === 'Enrolled').length;
    const noShow = leads.filter((l) => l.stage.includes('No Show')).length;
    return {
      total: leads.length,
      pipeline: leads.reduce((s, l) => s + (l.estimatedValue ?? 0), 0),
      enrolled,
      noShowRate: leads.length ? Math.round((noShow / leads.length) * 100) : 0,
    };
  }, [leads]);

  const formatDate = (iso: string | null) => {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(iso));
    } catch {
      return '—';
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title="Dashboard" description="Pipeline overview and lead management" />
        <PageBody>
          <PageLoader label="Loading pipeline" />
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Every lead in the pipeline, filterable by stage."
        actions={
          <Link href="/today">
            <Button variant="primary" iconRight={ArrowRight}>
              Today View
            </Button>
          </Link>
        }
      />

      <PageBody className="space-y-5">
        <SampleDataBanner page="figures" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 stagger">
          <KPITile
            label="Total Leads"
            value={stats.total}
            subtext="Across all stages"
            icon={Users}
            accent="info"
          />
          <KPITile
            label="Pipeline Value"
            value={`$${(stats.pipeline / 100).toLocaleString()}`}
            subtext="Estimated"
            icon={DollarSign}
            accent="accent"
          />
          <KPITile
            label="Enrolled"
            value={stats.enrolled}
            subtext="Closed won"
            icon={Trophy}
            accent="success"
          />
          <KPITile
            label="No-Show Rate"
            value={`${stats.noShowRate}%`}
            subtext="Currently in no-show stages"
            icon={UserX}
            accent="warning"
          />
        </div>

        {/* Filters */}
        <Card padding="sm">
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-full sm:w-56">
              <Input
                icon={Search}
                placeholder="Search name, email, source…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <div
              className="h-5 w-px mx-1 hidden sm:block"
              style={{ background: 'var(--border-subtle)' }}
            />

            <button
              onClick={() => setSelectedStage(null)}
              className="h-7 px-2.5 rounded-[6px] text-[12.5px] font-medium transition-all duration-150"
              style={
                selectedStage === null
                  ? {
                      background: 'var(--accent)',
                      color: 'var(--accent-text)',
                      boxShadow: 'var(--shadow-accent)',
                    }
                  : { color: 'var(--text-tertiary)' }
              }
            >
              All
              <span className="ml-1.5 tabular opacity-70">{leads.length}</span>
            </button>

            {STAGES.map((stage) => {
              const count = leads.filter((l) => l.stage === stage).length;
              const active = selectedStage === stage;

              return (
                <button
                  key={stage}
                  onClick={() => setSelectedStage(active ? null : stage)}
                  className="h-7 px-2.5 rounded-[6px] text-[12.5px] font-medium transition-all duration-150 hover:bg-[var(--surface-hover)]"
                  style={
                    active
                      ? {
                          background: 'var(--accent)',
                          color: 'var(--accent-text)',
                          boxShadow: 'var(--shadow-accent)',
                        }
                      : { color: 'var(--text-tertiary)' }
                  }
                >
                  {stage}
                  <span className="ml-1.5 tabular opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
        </Card>

        {/* Leads table */}
        <Card padding="none" className="overflow-hidden">
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderBottom: '1px solid var(--border-subtle)' }}
          >
            <h3
              className="text-[13.5px] font-semibold"
              style={{ color: 'var(--text-primary)' }}
            >
              {selectedStage ?? 'All leads'}
              <span
                className="ml-2 text-[12.5px] font-normal tabular"
                style={{ color: 'var(--text-quaternary)' }}
              >
                {filtered.length}
              </span>
            </h3>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              icon={<Inbox size={19} />}
              title="No leads match"
              description={
                query
                  ? 'Try a different search term or clear the stage filter.'
                  : 'Nothing in this stage right now.'
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[840px]">
                <thead>
                  <tr
                    style={{
                      borderBottom: '1px solid var(--border-subtle)',
                      background: 'var(--surface-sunken)',
                    }}
                  >
                    {['Name', 'Email', 'Stage', 'Appointment', 'Value', 'Owner'].map(
                      (h, i) => (
                        <th
                          key={h}
                          className={`px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.05em] ${
                            i >= 4 ? 'text-right' : 'text-left'
                          }`}
                          style={{ color: 'var(--text-quaternary)' }}
                        >
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((lead) => (
                    <tr
                      key={lead.id}
                      className="transition-colors hover:bg-[var(--surface-hover)]"
                      style={{ borderBottom: '1px solid var(--border-subtle)' }}
                    >
                      <td className="px-4 py-3">
                        <div
                          className="text-[13px] font-medium"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {lead.firstName} {lead.lastName}
                        </div>
                        <div
                          className="text-[11.5px] mt-0.5"
                          style={{ color: 'var(--text-quaternary)' }}
                        >
                          {lead.source ?? 'Unknown source'}
                        </div>
                      </td>
                      <td
                        className="px-4 py-3 text-[12.5px]"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {lead.email}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={STAGE_VARIANT[lead.stage] ?? 'neutral'}>
                          {lead.stage}
                        </Badge>
                      </td>
                      <td
                        className="px-4 py-3 text-[12.5px] tabular"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {formatDate(lead.appointmentTime)}
                      </td>
                      <td
                        className="px-4 py-3 text-right text-[13px] font-semibold tabular"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {lead.estimatedValue
                          ? `$${(lead.estimatedValue / 100).toLocaleString()}`
                          : '—'}
                      </td>
                      <td
                        className="px-4 py-3 text-right text-[12.5px]"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {lead.owner ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </PageBody>

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          isVisible={!!toast}
          onClose={() => setToast(null)}
        />
      )}
    </>
  );
}
