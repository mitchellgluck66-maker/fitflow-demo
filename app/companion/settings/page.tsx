import type { Metadata } from 'next';
import { CompanionSettings } from '@/components/companion/CompanionSettings';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default function CompanionSettingsPage() {
  return <CompanionSettings />;
}
