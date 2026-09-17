'use client';

import React, { Suspense, useState } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { Eye, EyeOff, LockKeyhole, ArrowRight } from 'lucide-react';
import { Button } from '@/components';
import { ThemeToggle } from '@/components/ThemeToggle';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = (() => {
    const n = params.get('next') ?? '/';
    // Only ever land somewhere inside this app.
    return n.startsWith('/') && !n.startsWith('//') ? n : '/';
  })();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.detail ? `${body.error}. ${body.detail}` : (body.error ?? 'Could not sign in'));
        return;
      }
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="w-full max-w-[380px] surface-raised rounded-[14px] p-6 space-y-5" aria-describedby={error ? 'login-error' : undefined}>
      <div className="flex items-center gap-3">
        <Image src="/logo.png" alt="FitFlow" width={36} height={36} priority style={{ width: 36, height: 36, objectFit: 'contain' }} />
        <div>
          <div className="text-[16px] font-semibold tracking-[-0.02em]" style={{ color: 'var(--text-primary)' }}>
            FitFlow
          </div>
          <div className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
            Growth intelligence · The Fit Physician
          </div>
        </div>
      </div>

      <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-[10px]" style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}>
        <LockKeyhole size={14} strokeWidth={2.3} className="mt-px shrink-0" style={{ color: 'var(--accent)' }} />
        <p className="text-[12.5px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
          This dashboard holds real client data. Enter the team password to continue.
        </p>
      </div>

      <div>
        <label htmlFor="password" className="block text-[12.5px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          Password
        </label>
        <div className="relative">
          <input
            id="password"
            type={show ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
            required
            aria-invalid={error ? true : undefined}
            className="w-full h-9 pl-3 pr-9 text-[13.5px] rounded-[8px] focus-ring"
            style={{ background: 'var(--surface)', color: 'var(--text-primary)', border: `1px solid ${error ? 'var(--negative-border, var(--danger))' : 'var(--border-default)'}` }}
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? 'Hide password' : 'Show password'}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 h-6 w-6 grid place-items-center rounded-[5px] transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: 'var(--text-quaternary)' }}
          >
            {show ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        </div>
        {error && (
          <p id="login-error" role="alert" className="text-[12.5px] mt-2" style={{ color: 'var(--negative-text, var(--danger))' }}>
            {error}
          </p>
        )}
      </div>

      <Button type="submit" variant="primary" iconRight={ArrowRight} loading={busy} disabled={!password} className="w-full">
        Sign in
      </Button>

      <p className="text-[11px]" style={{ color: 'var(--text-quaternary)' }}>
        Sessions last 30 days on this device. FitFlow only reads from GoHighLevel — nothing here changes the pipeline.
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen grid place-items-center px-4 py-10" style={{ background: 'var(--background, var(--surface-sunken))' }}>
      <div className="fixed top-3 right-3">
        <ThemeToggle />
      </div>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
