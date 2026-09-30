import type { Metadata } from 'next';

/** P2 #10: the browser tab names the page ("Funnel · FitFlow"); pages are client components, so the title lives in this server layout. */
export const metadata: Metadata = { title: 'Funnel' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
