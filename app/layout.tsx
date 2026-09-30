import type { Metadata, Viewport } from 'next';
import { describeError } from '@/lib/dbTimeout';
import './globals.css';
import { ThemeProvider, themeInitScript } from '@/components/ThemeProvider';
import { NavBar } from '@/components/NavBar';
import { StaleSyncBanner } from '@/components/StaleSyncBanner';
import { PageTransition } from '@/components/PageTransition';
import { BusinessTimezoneProvider } from '@/components/BusinessTimezone';
import { getTimezone } from '@/lib/settings';

// The layout reads the business timezone from the database on every request (F8) — never prerendered.
export const dynamic = 'force-dynamic';

async function resolveTimezone(): Promise<{ timezone: string | null; error: string | null }> {
  try {
    return { timezone: await getTimezone(), error: null };
  } catch (err) {
    // The driver's cause, never the query text (lib/dbTimeout#describeError).
    return { timezone: null, error: `Business timezone could not be read — ${describeError(err)}` };
  }
}

export const metadata: Metadata = {
  // P2 #10: each route's server layout sets its title ("Reports · FitFlow"); the root page is the Command Center.
  title: { default: 'Command Center · FitFlow', template: '%s · FitFlow' },
  description:
    'Growth intelligence for The Fit Physician: funnel, ad spend, CAC and cash, read-only from GoHighLevel, Meta and Stripe.',
  icons: { icon: '/icon.png', apple: '/apple-icon.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f7f8' },
    { media: '(prefers-color-scheme: dark)', color: '#08090a' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const tz = await resolveTimezone();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the stored theme before first paint, so there is no flash of
            the wrong colour scheme on load. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />

        {/* Inter is loaded via stylesheet rather than next/font on purpose:
            next/font resolves at build time and hard-fails the build when
            fonts.googleapis.com is unreachable (offline dev, locked-down CI).
            A plain stylesheet degrades gracefully instead - if it can't load,
            the system stack in globals.css takes over and the app still looks
            right, because that fallback is SF Pro on macOS. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
        />
      </head>
      <body className="min-h-screen antialiased">
        <ThemeProvider>
          <BusinessTimezoneProvider timezone={tz.timezone} error={tz.error}>
            <NavBar />
            {tz.error && (
              <div role="alert" className="px-4 py-2 text-[13px] text-center" style={{ background: 'var(--negative-muted, var(--danger-muted))', color: 'var(--negative-text, var(--danger))' }}>
                {tz.error}
              </div>
            )}
            <StaleSyncBanner />
            <PageTransition>{children}</PageTransition>
          </BusinessTimezoneProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
