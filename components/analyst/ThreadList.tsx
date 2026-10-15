'use client';

import { useEffect } from 'react';
import { useAnalyst } from './AnalystProvider';

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** The shared conversation list (one history, no author filter) behind the Conversations button. */
export function ThreadList() {
  const a = useAnalyst();
  useEffect(() => {
    void a.refreshThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="analyst-threads" data-testid="analyst-threads">
      <div className="analyst-threads-head">
        <span>Conversations</span>
        <button type="button" className="analyst-link" onClick={a.newConversation}>
          New conversation
        </button>
      </div>
      {a.threadsLoading && a.threads.length === 0 ? <p className="analyst-muted">Loading…</p> : null}
      {!a.threadsLoading && a.threads.length === 0 ? <p className="analyst-muted">No conversations yet.</p> : null}
      <ul>
        {a.threads.map((t) => (
          <li key={t.id}>
            <button type="button" className={`analyst-thread${t.id === a.threadId ? ' is-current' : ''}`} onClick={() => void a.openThread(t.id)}>
              <b>{t.title ?? 'Untitled conversation'}</b>
              <span>
                {when(t.lastTurnAt ?? t.createdAt)} · {t.model.includes('fable') ? 'Fable 5.1' : 'Opus 5.5'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
