'use client';

import React, { useEffect, useState } from 'react';
import { Lock, LockOpen, ShieldAlert } from 'lucide-react';

type Mode = 'on' | 'dev-plaintext' | 'missing' | 'invalid';

/**
 * H4: whether stored credentials are encrypted at rest. Production without a
 * valid CREDENTIALS_KEY fails closed — this is where Setup says so, plainly,
 * with the fix. The key itself never reaches the client.
 */
export const CredentialsKeyNotice: React.FC = () => {
  const [state, setState] = useState<{ mode: Mode; message: string } | null>(null);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { credentials?: { mode: Mode; message: string } } | null) => d?.credentials && setState(d.credentials))
      .catch(() => undefined);
  }, []);

  if (!state) return null;
  const locked = state.mode === 'missing' || state.mode === 'invalid';
  const Icon = locked ? ShieldAlert : state.mode === 'on' ? Lock : LockOpen;
  const color = locked ? 'var(--danger)' : state.mode === 'on' ? 'var(--success)' : 'var(--text-tertiary)';

  return (
    <div
      role={locked ? 'alert' : undefined}
      className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-[10px]"
      style={
        locked
          ? { background: 'var(--negative-muted)', border: '1px solid var(--negative-border)' }
          : { background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }
      }
    >
      <Icon size={15} strokeWidth={2.3} className="mt-px shrink-0" style={{ color }} />
      <p className="text-[12.5px] leading-snug" style={{ color: locked ? 'var(--negative-text)' : 'var(--text-secondary)' }}>
        {locked && <strong>Credentials locked. </strong>}
        {state.message}
      </p>
    </div>
  );
};
