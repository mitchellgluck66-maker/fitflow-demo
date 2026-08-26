'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import {
  LayoutDashboard,
  CalendarCheck,
  BarChart3,
  FileText,
  ScrollText,
  Settings as SettingsIcon,
  Plug,
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';

const LINKS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/today', label: 'Today', icon: CalendarCheck },
  { href: '/metrics', label: 'Metrics', icon: BarChart3 },
  { href: '/reports', label: 'Reports', icon: FileText },
  { href: '/audit-log', label: 'Audit', icon: ScrollText },
  { href: '/setup', label: 'Setup', icon: Plug },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

export const NavBar: React.FC = () => {
  const pathname = usePathname();
  const [syncState, setSyncState] = useState<{ isDryRun: boolean; pending: number } | null>(
    null,
  );

  useEffect(() => {
    fetch('/api/sync')
      .then((r) => r.json())
      .then((d) =>
        setSyncState({
          isDryRun: d.stats?.isDryRun ?? true,
          pending: d.stats?.pending ?? 0,
        }),
      )
      .catch(() => {});
  }, [pathname]);

  return (
    <header
      className="sticky top-0 z-50"
      style={{
        background: 'var(--surface-overlay)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <div className="max-w-[1400px] mx-auto px-5">
        <div className="flex items-center h-[52px] gap-1">
          {/* Wordmark */}
          <Link href="/" className="flex items-center gap-2 mr-5 shrink-0 group">
            <Image
              src="/logo.png"
              alt="FitFlow"
              width={28}
              height={28}
              priority
              className="transition-transform duration-200 group-hover:scale-105"
              style={{ width: 28, height: 28, objectFit: 'contain' }}
            />
            <span
              className="text-[14.5px] font-semibold tracking-[-0.02em]"
              style={{ color: 'var(--text-primary)' }}
            >
              FitFlow
            </span>
          </Link>

          {/* Primary nav */}
          <nav className="flex items-center gap-0.5 min-w-0 overflow-x-auto">
            {LINKS.map((link) => {
              const active = link.exact
                ? pathname === link.href
                : pathname.startsWith(link.href);
              const Icon = link.icon;

              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={clsx(
                    'relative flex items-center gap-1.5 h-[30px] px-2.5 rounded-[7px]',
                    'text-[13px] font-medium transition-all duration-150 whitespace-nowrap',
                    !active && 'hover:bg-[var(--surface-hover)]',
                  )}
                  style={{
                    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    background: active ? 'var(--surface-hover)' : 'transparent',
                  }}
                >
                  <Icon
                    size={14}
                    strokeWidth={active ? 2.4 : 2}
                    style={{ color: active ? 'var(--accent)' : 'inherit' }}
                  />
                  {link.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex-1" />

          {/* Right cluster */}
          <div className="flex items-center gap-2 shrink-0">
            {syncState?.isDryRun && (
              <div
                title="GoHighLevel writes are queued but not sent. Add credentials and set GHL_DRY_RUN=false to go live."
                className="hidden sm:flex items-center gap-1.5 h-[26px] px-2 rounded-[6px] text-[11.5px] font-medium"
                style={{
                  background: 'var(--warning-muted)',
                  color: 'var(--warning)',
                  border: '1px solid var(--warning-border)',
                }}
              >
                <span
                  className="rounded-full"
                  style={{
                    width: 5,
                    height: 5,
                    background: 'currentColor',
                    animation: 'pulseSoft 2s ease-in-out infinite',
                  }}
                />
                Dry run
                {syncState.pending > 0 && (
                  <span className="tabular opacity-80">· {syncState.pending}</span>
                )}
              </div>
            )}

            <ThemeToggle />
          </div>
        </div>
      </div>
    </header>
  );
};
