'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Command, CornerDownLeft } from 'lucide-react';
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

function roleVariant(role: string | null): 'success' | 'danger' | 'neutral' {
  if (role === 'enrolled') return 'success';
  if (role === 'consult_noshow') return 'danger';
  return 'neutral';
}

/**
 * Global contact search: ⌘K / Ctrl+K anywhere, or the nav button. Finds
 * people by name, email or phone digits and jumps to their profile.
 */
export const GlobalSearch: React.FC = () => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setHits([]);
    setActive(0);
  }, []);

  // ⌘K / Ctrl+K opens; Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape') {
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      const t = setTimeout(() => setHits([]), 0);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    const t = setTimeout(() => {
      setSearching(true);
      fetch(`/api/contacts/search?q=${encodeURIComponent(q)}`)
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
  }, [query, open]);

  const go = (hit: Hit) => {
    close();
    router.push(`/clients/${hit.id}`);
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(hits.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && hits[active]) {
      e.preventDefault();
      go(hits[active]);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Search clients (⌘K)"
        className="hidden sm:flex items-center gap-1.5 h-[26px] px-2 rounded-[6px] text-[11.5px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
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
        onClick={() => setOpen(true)}
        aria-label="Search clients"
        className="sm:hidden h-[26px] w-[26px] grid place-items-center rounded-[6px] hover:bg-[var(--surface-hover)]"
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

            <div className="max-h-[52vh] overflow-y-auto py-1.5">
              {query.trim().length < 2 ? (
                <p className="px-4 py-6 text-center text-[12.5px]" style={{ color: 'var(--text-quaternary)' }}>
                  Type at least two characters.
                </p>
              ) : hits.length === 0 ? (
                <p className="px-4 py-6 text-center text-[12.5px]" style={{ color: 'var(--text-quaternary)' }}>
                  {searching ? 'Searching…' : 'No one matches.'}
                </p>
              ) : (
                hits.map((hit, i) => (
                  <button
                    key={hit.id}
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(hit)}
                    className="w-full flex items-center gap-3 px-3.5 py-2 text-left"
                    style={{ background: i === active ? 'var(--surface-hover)' : 'transparent' }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                        {hit.name}
                      </div>
                      <div className="text-[11.5px] truncate" style={{ color: 'var(--text-tertiary)' }}>
                        {[hit.email, hit.phone, hit.source].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    {hit.stage && (
                      <Badge variant={roleVariant(hit.role)} size="xs">
                        {hit.stage}
                      </Badge>
                    )}
                    {i === active && <CornerDownLeft size={12} style={{ color: 'var(--text-quaternary)' }} />}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
