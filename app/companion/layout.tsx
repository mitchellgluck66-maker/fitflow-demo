import type { Metadata } from 'next';
import { CompanionShell } from '@/components/companion/CompanionShell';

export const metadata: Metadata = { title: { default: 'My day · Companion', template: '%s · Companion' } };

/**
 * The Onboarding Companion (stage 1, read-only): its own slim shell. The root layout's NavBar, stale banner and
 * Analyst orb stay off these routes — an onboarding login never sees the dashboard.
 */
export default function CompanionLayout({ children }: { children: React.ReactNode }) {
  return <CompanionShell>{children}</CompanionShell>;
}
