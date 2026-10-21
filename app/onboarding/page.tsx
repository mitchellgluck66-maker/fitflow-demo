import { Suspense } from 'react';
import { OnboardingPage } from '@/components/onboarding/OnboardingPage';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <Suspense fallback={null}>
      <OnboardingPage />
    </Suspense>
  );
}
