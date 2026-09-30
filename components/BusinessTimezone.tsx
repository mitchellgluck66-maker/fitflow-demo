'use client';

/**
 * The business timezone, resolved ONCE on the server (app/layout.tsx → lib/settings#getTimezone) and handed to
 * every client component (F8, 2026-09-30). No component carries its own America/New_York default any more:
 * when the timezone is not configured, `useBusinessTimezone()` returns null and callers render the error.
 */
import React, { createContext, useContext } from 'react';

const Ctx = createContext<{ timezone: string | null; error: string | null }>({ timezone: null, error: null });

export function BusinessTimezoneProvider({ timezone, error, children }: { timezone: string | null; error: string | null; children: React.ReactNode }) {
  return <Ctx.Provider value={{ timezone, error }}>{children}</Ctx.Provider>;
}

/** The business timezone, or null (with `error`) when it is not configured. */
export function useBusinessTimezone(): { timezone: string | null; error: string | null } {
  return useContext(Ctx);
}

/** Shown wherever a date control needs the timezone and it is missing — never a silent default. */
export function TimezoneMissing({ error }: { error: string | null }) {
  return (
    <span role="alert" className="text-[12.5px]" style={{ color: 'var(--negative-text, var(--danger))' }}>
      {error ?? 'Business timezone is not configured — set it in Setup.'}
    </span>
  );
}
