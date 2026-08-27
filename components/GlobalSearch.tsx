'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Command, CornerDownLeft, Clock, X } from 'lucide-react';
import { Badge } from './Badge';

interface Hit {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  stage: string | null;
  role: string | null;
  source: string | null;
}

interface Recent {
  id: string;
  name: string;
  sub: string;
}

const RECENTS_KEY = 'fitflow.search.recents';
const MAX_RECENTS = 5;

function roleVariant(role: string | null): 'positive' | 'negative' | 'neutral' {
  if (role === 'enrolled') return 'positive';
  if (role === 'consult_noshow') return 'negative';
  return 'neutral';
}

function readRecents(): Recent[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Recent[]) : [];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

function writeRecents(list: Recent[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENTS)));
  } catch {
    /* private mode / quota — recents are a nicety */
  }
}

/**
 * Global contact search: ⌘K / Ctrl+K anywhere, or the nav button. Finds
 * people by name, email or phone digits and jumps to their profile.
 *
 * Keyboard: ↑/↓ move (wrapping), Enter opens, Esc closes, typing anywhere in
 * the palette refocuses the input. The active option is announced via
 * aria-activedescendant. With an empty query the last five people you opened
 * are offered (localStorage, per browser).
 */
export const GlobalSearch: React.FC = () => {
  const router = useRouter();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [recents, setRecents] = useState<Recent[]>([]);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const trimmed = query.trim();
  const showingRecents = trimmed.length < 2;
  const options: Array<{ id: string; name: string; sub: string; hit?: Hit }> = showingRecents
    ? recents.map((r) => ({ id: r.id, name: r.name, sub: r.sub }))
    : hits.map((h) => ({ id: h.id, name: h.name, sub: [h.email, h.phone, h.source].filter(Boolean).join(' · '), hit: h }));

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setHits([]);
    setActive(0);
  }, []);

  const openPalette = useCallback(() => {
    setRecents(readRecents());
    setActive(0);
    setOpen(true);
  }, []);

  // ⌘K / Ctrl+K toggles; Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (open) close();
        else openPalette();
      } else if (e.key === 'Escape' && open) {
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close, openPalette]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    if (trimmed.length < 2) {
      const t = setTimeout(() => setHits([]), 0);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    const t = setTimeout(() => {
      setSearching(true);
      fetch(`/api/contacts/search?q=${encodeURIComponent(trimmed)}`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          setHits(Array.isArray(d.people) ? d.people : []);
          setActive(0);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [trimmed, open]);

  // Keep the active option in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, options.length]);

  const go = (opt: { id: string; name: string; sub: string }) => {
    const next = [{ id: opt.id, name: opt.name, sub: opt.sub }, ...readRecents().filter((r) => r.id !== opt.id)];
    writeRecents(next);
    close();
    router.push(`/clients/${opt.id}`);
  };

  const removeRecent = (id: string) => {
    const next = readRecents().filter((r) => r.id !== id);
    writeRecents(next);
    setRecents(next);
    setActive(0);
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const n = options.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (n > 0) setActive((i) => (i + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n > 0) setActive((i) => (i - 1 + n) % n);
    } else if (e.key === 'Home' && n > 0) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && n > 0) {
      e.preventDefault();
      setActive(n - 1);
    } else if (e.key === 'Enter' && options[active]) {
      e.preventDefault();
      go(options[active]);
    }
  };

  // Typing anywhere inside the dialog goes to the input.
  const onDialogKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target === inputRef.current) return;
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) inputRef.current?.focus();
  };

  const activeId = options[active] ? `${listId}-opt-${active}` : undefined;

  return (
    <>
      <button
        type="button"
        onClick={openPalette}
        title="Search clients (⌘K)"
        className="focus-ring hidden sm:flex items-center gap-1.5 h-[26px] px-2 rounded-[6px] text-[11.5px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
        style={{ color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)', background: 'var(--surface-sunken)' }}
      >
        <Search size={12} strokeWidth={2.2} />
        Search
        <span className="ml-1 flex items-center gap-0.5 text-[10.5px]" style={{ color: 'var(--text-quaternary)' }}>
          <Command size={10} />K
        </span>
      </button>
      <button
        type="button"
        onClick={openPalette}
        aria-label="Search clients"
        className="focus-ring sm:hidden h-[26px] w-[26px] grid place-items-center rounded-[6px] hover:bg-[var(--surface-hover)]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        <Search size={14} />
      </button>

      {open && (
        <div className="fixed inset-0 z-[95] flex items-start justify-center pt-[12vh] px-4">
          <div
            onClick={close}
            className="absolute inset-0 animate-fade"
            style={{ background: 'rgba(8, 9, 10, 0.5)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Search clients"
            onKeyDown={onDialogKey}
            className="relative w-full max-w-lg rounded-[14px] overflow-hidden animate-scale"
            style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-xl)' }}
          >
            <div className="flex items-center gap-2 px-3.5 h-12" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <Search size={15} strokeWidth={2.2} style={{ color: 'var(--text-quaternary)' }} />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKey}
                role="combobox"
                aria-expanded={options.length > 0}
                aria-controls={listId}
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                placeholder="Search by name, email or phone…"
                className="flex-1 bg-transparent outline-none text-[14px] h-full"
                style={{ color: 'var(--text-primary)', border: 'none', boxShadow: 'none' }}
                autoComplete="off"
                spellCheck={false}
              />
              <kbd className="text-[10.5px] px-1.5 py-0.5 rounded" style={{ color: 'var(--text-quaternary)', border: '1px solid var(--border-subtle)' }}>
                esc
              </kbd>
            </div>

            <div ref={listRef} id={listId} role="listbox" aria-label={showingRecents ? 'Recent' : 'Results'} className="max-h-[52vh] overflow-y-auto py-1.5">
              {showingRecents && options.length === 0 ? (
                <p className="px-4 py-6 text-center text-[12.5px]" style={{ color: 'var(--text-quaternary)' }}>
                  Type a name, email or phone number.
                </p>
              ) : !showingRecents && options.length === 0 ? (
                <p className="px-4 py-6 text-center text-[12.5px]" style={{ color: 'var(--text-quaternary)' }} aria-live="polite">
                  {searching ? 'Searching…' : `No results for “${trimmed}”.`}
                </p>
              ) : (
                <>
                  {showingRecents && (
                    <div className="px-3.5 pt-1 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em]" style={{ color: 'var(--text-quaternary)' }}>
                      Recent
                    </div>
                  )}
                  {options.map((opt, i) => {
                    const isActive = i === active;
                    return (
                      <div
                        key={opt.id}
                        id={`${listId}-opt-${i}`}
                        data-index={i}
                        role="option"
                        aria-selected={isActive}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => go(opt)}
                        className="row-clickable w-full flex items-center gap-3 px-3.5 py-2 text-left"
                        style={{ background: isActive ? 'var(--surface-hover)' : 'transparent' }}
                      >
                        {showingRecents && <Clock size={13} strokeWidth={2.2} style={{ color: 'var(--text-quaternary)' }} />}
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                            {opt.name}
                          </div>
                          <div className="text-[11.5px] truncate" style={{ color: 'var(--text-tertiary)' }}>
                            {opt.sub || '—'}
                          </div>
                        </div>
                        {opt.hit?.stage && (
                          <Badge variant={roleVariant(opt.hit.role)} size="xs">
                            {opt.hit.stage}
                          </Badge>
                        )}
                        {showingRecents ? (
                          <button
                            type="button"
                            aria-label={`Remove ${opt.name} from recent`}
                            onClick={(e) => {
                              e.stopPropagation();
                              removeRecent(opt.id);
                            }}
                            className="focus-ring h-5 w-5 grid place-items-center rounded-[4px] hover:bg-[var(--surface-active)]"
                            style={{ color: 'var(--text-quaternary)' }}
                          >
                            <X size={11} />
                          </button>
                        ) : (
                          isActive && <CornerDownLeft size={12} style={{ color: 'var(--text-quaternary)' }} />
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>

            <div className="flex items-center gap-3 px-3.5 h-8 text-[10.5px]" style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--text-quaternary)' }}>
              <span>↑↓ move</span>
              <span>↵ open</span>
              <span>esc close</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
