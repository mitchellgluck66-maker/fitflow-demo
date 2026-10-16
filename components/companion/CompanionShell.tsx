'use client';

import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import clsx from 'clsx';
import { CalendarDays, Settings2, LogOut } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';

const LINKS = [
  { href: '/companion', label: 'My day', icon: CalendarDays },
  { href: '/companion/settings', label: 'Settings', icon: Settings2 },
];

/** The Companion's header: wordmark, My day / Settings, theme, sign out. The pop-out page renders no chrome at all. */
export const CompanionShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = React.useState(false);
  if (pathname === '/companion/popout') return <>{children}</>;

  const signOut = async () => {
    setSigningOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-canvas)' }}>
      <header className="sticky top-0" style={{ zIndex: 'var(--z-nav)' as unknown as number, background: 'var(--surface-overlay)', backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)', borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="max-w-[760px] mx-auto px-4">
          <div className="flex items-center h-[50px] gap-1">
            <Link href="/companion" className="flex items-center gap-2 mr-3 shrink-0">
              <Image src="/logo.png" alt="FitFlow" width={26} height={26} priority style={{ width: 26, height: 26, objectFit: 'contain' }} />
              <span className="text-[14px] font-semibold tracking-[-0.02em]" style={{ color: 'var(--text-primary)' }}>
                Companion
              </span>
            </Link>
            <nav className="flex items-center gap-0.5" aria-label="Companion">
              {LINKS.map(({ href, label, icon: Icon }) => {
                const active = pathname === href;
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    className={clsx('flex items-center gap-1.5 h-8 px-2.5 rounded-[7px] text-[13px] font-medium transition-colors focus-ring', active ? 'bg-[var(--surface-active)]' : 'hover:bg-[var(--surface-hover)]')}
                    style={{ color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                  >
                    <Icon size={14} strokeWidth={2.2} />
                    <span className="hidden sm:inline">{label}</span>
                  </Link>
                );
              })}
            </nav>
            <div className="ml-auto flex items-center gap-1">
              <ThemeToggle />
              <button
                type="button"
                onClick={signOut}
                disabled={signingOut}
                className="flex items-center gap-1.5 h-8 px-2.5 rounded-[7px] text-[13px] font-medium transition-colors hover:bg-[var(--surface-hover)] focus-ring"
                style={{ color: 'var(--text-secondary)' }}
              >
                <LogOut size={14} strokeWidth={2.2} />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </div>
          </div>
        </div>
      </header>
      <main className="max-w-[760px] mx-auto px-4 py-5">{children}</main>
    </div>
  );
};
