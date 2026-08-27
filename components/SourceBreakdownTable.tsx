'use client';

import React, { useMemo } from 'react';
import { Badge } from './Badge';
import { EmptyState } from './PageHeader';
import { FilterBar, NoMatches } from './FilterBar';
import { SortableHeader } from './SortableHeader';
import { useTableState, applyClient, facetOptions } from './useTableState';
import { formatPct, FUNNEL_STAGES, type SourceBreakdown, type FunnelStageKey } from '@/lib/metrics';

const FACETS = ['source'];

/**
 * Per-source funnel table (Funnel tab): source × six stage counts ×
 * applied→enrolled × consult show rate. Filterable + sortable; state in the
 * URL under the `s_` prefix.
 */
export const SourceBreakdownTable: React.FC<{ sources: SourceBreakdown[] }> = ({ sources }) => {
  const t = useTableState({ prefix: 's_', facetKeys: FACETS });

  const rows = useMemo(
    () =>
      applyClient(sources, t.state, {
        search: [(s) => s.source],
        facets: { source: (s) => s.source },
        sorts: {
          source: (s) => s.source,
          ...Object.fromEntries(FUNNEL_STAGES.map((st) => [st.key, (s: SourceBreakdown) => s.counts[st.key]])),
          conversion: (s) => s.appliedToEnrolled,
          showRate: (s) => s.consultShowRate,
        },
        defaultSort: { key: 'applied', dir: 'desc' },
      }),
    [sources, t.state],
  );

  if (sources.length === 0) return <EmptyState title="No contacts in this period" />;

  const th = { color: 'var(--text-quaternary)' };

  return (
    <div className="space-y-3">
      <FilterBar
        state={t.state}
        facets={[{ key: 'source', label: 'Source', options: facetOptions(sources, (s) => s.source) }]}
        onQ={t.setQ}
        onToggle={t.toggleFilter}
        onClear={t.clearFilters}
        shown={rows.length}
        total={sources.length}
        placeholder="Search sources…"
        noun="sources"
      />
      {rows.length === 0 ? (
        <NoMatches onClear={t.clearFilters} noun="sources" />
      ) : (
        <div className="overflow-x-auto rounded-[8px]" style={{ border: '1px solid var(--border-subtle)' }}>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr style={{ background: 'var(--surface-sunken)' }}>
                <SortableHeader label="Source" sortKey="source" activeKey={t.state.sort ?? 'applied'} dir={t.state.dir} onSort={t.setSort} style={th} />
                {FUNNEL_STAGES.map((s) => (
                  <SortableHeader key={s.key} label={s.label} sortKey={s.key} activeKey={t.state.sort ?? 'applied'} dir={t.state.sort ? t.state.dir : 'desc'} onSort={t.setSort} align="right" style={th} />
                ))}
                <SortableHeader label="Applied → enrolled" sortKey="conversion" activeKey={t.state.sort} dir={t.state.dir} onSort={t.setSort} align="right" style={th} />
                <SortableHeader label="Consult show rate" sortKey="showRate" activeKey={t.state.sort} dir={t.state.dir} onSort={t.setSort} align="right" style={th} />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.source} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td className="px-3 py-2 font-medium" style={{ color: 'var(--text-primary)' }}>
                    {s.source}
                  </td>
                  {FUNNEL_STAGES.map((st) => (
                    <td key={st.key} className="px-3 py-2 tabular text-right" style={{ color: st.key === ('enrolled' as FunnelStageKey) && s.counts.enrolled > 0 ? 'var(--positive-text, var(--success))' : 'var(--text-secondary)' }}>
                      {s.counts[st.key]}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right">
                    <Badge variant={s.appliedToEnrolled === null ? 'neutral' : s.appliedToEnrolled >= 0.1 ? 'positive' : s.appliedToEnrolled > 0 ? 'warning' : 'negative'} size="xs">
                      {formatPct(s.appliedToEnrolled)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 tabular text-right" style={{ color: 'var(--text-secondary)' }}>
                    {formatPct(s.consultShowRate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
