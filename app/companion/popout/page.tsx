import { Suspense } from 'react';
import type { Metadata } from 'next';
import { PopOut } from '@/components/companion/PopOut';

export const metadata: Metadata = { title: 'Brief' };
export const dynamic = 'force-dynamic';

/** The pop-out window's page (also usable in a tab): the current call's client brief. No shell. */
export default function PopOutPage() {
  return (
    <Suspense fallback={null}>
      <PopOut />
    </Suspense>
  );
}
