'use client';

import React from 'react';
import { Badge } from '@/components';
import { formatTime } from '@/lib/day';
import type { CallAction, CallStatus, CompanionCall, GhlOutcome } from '@/lib/companion/day';

/** The one status chip (lib/companion/day#statusOf). Stage 2: Logged · <outcome>, Dry run · <outcome>, Failed · <step>. */
export const StatusChip: React.FC<{ status: CallStatus; outcomeInGhl: GhlOutcome | null; action?: CallAction | null }> = ({ status, outcomeInGhl, action }) => {
  switch (status) {
    case 'up_next':
      return <Badge variant="info" size="xs" dot>Up next</Badge>;
    case 'in_progress':
      return <Badge variant="accent" size="xs" dot>In progress</Badge>;
    case 'needs_outcome':
      return <Badge variant="warning" size="xs" dot>Needs outcome</Badge>;
    case 'logged':
      return (
        <Badge variant="success" size="xs" dot>
          Logged{action ? ` · ${action.label}` : ''}
        </Badge>
      );
    case 'dry_run':
      return (
        <Badge variant="warning" size="xs">
          Dry run{action ? ` · ${action.label}` : ''}
        </Badge>
      );
    case 'failed':
      return (
        <Badge variant="danger" size="xs" dot>
          Failed{action?.failedStep ? ` · ${action.failedStep}` : ''}
        </Badge>
      );
    case 'ghl_outcome':
      return outcomeInGhl === 'showed' ? <Badge variant="positive" size="xs">Showed in GHL</Badge> : outcomeInGhl === 'no_show' ? <Badge variant="negative" size="xs">No-show in GHL</Badge> : <Badge variant="neutral" size="xs">Cancelled in GHL</Badge>;
  }
};

export const CallTypeTag: React.FC<{ callType: CompanionCall['callType']; calendarName: string }> = ({ callType, calendarName }) => (
  <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium" style={{ color: 'var(--text-tertiary)' }} title={calendarName}>
    <span style={{ color: callType === 'Roadmap' ? 'var(--accent)' : callType === 'Consult' ? 'var(--info)' : 'var(--text-tertiary)' }}>{callType === 'Other' ? calendarName : callType}</span>
    {callType !== 'Other' && <span className="hidden sm:inline" style={{ color: 'var(--text-quaternary)' }}>· {calendarName}</span>}
  </span>
);

export const timeRange = (c: Pick<CompanionCall, 'startIso' | 'endIso'>, timezone: string) => (c.endIso ? `${formatTime(c.startIso, timezone)} – ${formatTime(c.endIso, timezone)}` : formatTime(c.startIso, timezone));

/** "Live from GoHighLevel, 10:42 AM" / the amber mirror line. */
export const SourceLine: React.FC<{ source: 'live' | 'mirror' | 'none'; fetchedAt: string; asOf: string | null; reason: string | null; timezone: string; onRetry?: () => void; compact?: boolean }> = ({ source, fetchedAt, asOf, reason, timezone, onRetry, compact }) => {
  if (source === 'live') {
    return (
      <p className={compact ? 'text-[11px]' : 'text-[12px]'} style={{ color: 'var(--text-quaternary)' }}>
        Live from GoHighLevel, {formatTime(fetchedAt, timezone)}
      </p>
    );
  }
  if (source === 'none') return null;
  return (
    <div role="status" className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] ${compact ? 'px-2.5 py-1.5 text-[11.5px]' : 'px-3 py-2 text-[12.5px]'}`} style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)', color: 'var(--text-primary)' }}>
      <span>
        Showing data from {asOf ? formatTime(asOf, timezone) : 'the last sync'} — GoHighLevel could not be reached{reason ? `: ${reason}` : ''}
      </span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="underline underline-offset-2 focus-ring rounded" style={{ color: 'var(--warning)' }}>
          Retry
        </button>
      )}
    </div>
  );
};

/** The yellow dry-run line (pop-out + My day). */
export const DryRunBanner: React.FC<{ compact?: boolean }> = ({ compact }) => (
  <div role="status" data-testid="companion-dry-run" className={`${compact ? 'px-2.5 py-1.5 text-[11.5px]' : 'px-3 py-2 text-[12.5px]'} rounded-[8px]`} style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)', color: 'var(--text-primary)' }}>
    <strong>Dry run</strong> — outcomes are logged here, nothing is sent to GoHighLevel. The owner turns this off in Setup → Companion.
  </div>
);
