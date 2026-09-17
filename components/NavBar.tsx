'use client';

import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import clsx from 'clsx';
import {
  LayoutDashboard,
  ClipboardList,
  Filter,
  Megaphone,
  Banknote,
  Users,
  FileText,
  Plug,
  Eye,
  LogOut,
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { GlobalSearch } from './GlobalSearch';

const LINKS = [
  { href: '/', label: 'Command Center', icon: LayoutDashboard, exact: true },
  { href: '/scorecard', label: 'Scorecard', icon: ClipboardList },
  { href: '/funnel', label: 'Funnel', icon: Filter },
  { href: '/ads', label: 'Ads', icon: Megaphone },
  { href: '/revenue', label: 'Revenue', icon: Banknote },
  { href: '/clients', label: 'Clients', icon: Users },
  { href: '/reports', label: 'Reports', icon: FileText },
  { href: '/setup', label: 'Setup', icon: Plug },
];

export const NavBar: React.FC = () => {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = React.useState(false);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  };

  // The gate has no chrome.
  if (pathname === '/login') return null;

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
            <GlobalSearch />
            <div
              title="FitFlow only reads from GoHighLevel. Nothing here changes Miranda's pipeline."
              className="hidden sm:flex items-center gap-1.5 h-[26px] px-2 rounded-[6px] text-[11.5px] font-medium"
              style={{
                background: 'var(--surface-sunken)',
                color: 'var(--text-tertiary)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <Eye size={12} strokeWidth={2.2} />
              Read-only
            </div>

            <ThemeToggle />
            <button
              type="button"
              onClick={signOut}
              disabled={signingOut}
              title="Sign out of FitFlow on this device"
              className="focus-ring flex items-center gap-1.5 h-[26px] px-2 rounded-[6px] text-[11.5px] font-medium transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
              style={{ color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)' }}
            >
              <LogOut size={12} strokeWidth={2.2} />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
