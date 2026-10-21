'use client';

import React from 'react';
import { useSearchParams } from 'next/navigation';
import { PopOutView, TAB_HOST } from './PopOutView';

/**
 * The /companion/popout page: the pop-out view in the host the URL names — `host=pip` inside the floating
 * Document Picture-in-Picture window (stage 4, item 2), else a plain tab (`float=0` from stage 1's links).
 * The Next.js dev indicator is hidden here: its host element is `<nextjs-portal>`.
 */
export const PopOut: React.FC = () => {
  const params = useSearchParams();
  return (
    <>
      <style>{'nextjs-portal{display:none !important}'}</style>
      <PopOutView date={params.get('date')} user={params.get('user')} event={params.get('event')} host={TAB_HOST} previewState={params.get('preview')} />
    </>
  );
};
