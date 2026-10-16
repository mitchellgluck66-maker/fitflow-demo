import { Suspense } from 'react';
import { MyDay } from '@/components/companion/MyDay';

export const dynamic = 'force-dynamic';

export default function CompanionPage() {
  return (
    <Suspense fallback={null}>
      <MyDay />
    </Suspense>
  );
}
