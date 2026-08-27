import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ThemeProvider, themeInitScript } from '@/components/ThemeProvider';
import { NavBar } from '@/components/NavBar';
import { PageTransition } from '@/components/PageTransition';

export const metadata: Metadata = {
  title: 'FitFlow — Sales Onboarding',
  description:
    'Attendance tracking and pipeline management for fitness coaching onboarding.',
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
          <NavBar />
          <PageTransition>{children}</PageTransition>
        </ThemeProvider>
      </body>
    </html>
  );
}
