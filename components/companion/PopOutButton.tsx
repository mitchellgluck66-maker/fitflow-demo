'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PictureInPicture2 } from 'lucide-react';
import { Button } from '@/components';
import { pipDocumentHtml, popOutMode, popOutUrl, requestedPipSize, type DocumentPipHost } from '@/lib/companion/popout';
import { readCollapsed } from '@/lib/companion/popoutState';
import { FloatingPanel } from './FloatingPanel';

/**
 * "Pop out": a Document Picture-in-Picture window (Chrome 116+) holding /companion/popout, always on top — opened
 * with ONLY a size (the saved collapsed state's), never `preferInitialWindowPlacement`, so Chrome reopens it where it
 * was. Elsewhere the in-page floating panel (stage 4). One window at a time — a second click focuses it. A refused
 * PiP request is shown under the button and falls back to the panel; nothing is swallowed.
 */
export const PopOutButton: React.FC<{ date: string | null; user: string | null; event?: string | null; size?: 'sm' | 'md' }> = ({ date, user, event, size = 'sm' }) => {
  const params = useSearchParams();
  const [note, setNote] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const winRef = useRef<Window | null>(null);

  const openPanel = useCallback(() => setPanelOpen(true), []);
  const closePanel = useCallback(() => setPanelOpen(false), []);

  // `?popout=panel` opens the in-page panel on load (a bookmark; the screenshots) — the floating window needs a click.
  const autoOpen = params.get('popout') === 'panel';
  useEffect(() => {
    if (!autoOpen) return;
    const t = setTimeout(() => setPanelOpen(true), 0);
    return () => clearTimeout(t);
  }, [autoOpen]);

  const open = async () => {
    const host = window as unknown as DocumentPipHost;
    if (winRef.current && !winRef.current.closed) {
      winRef.current.focus();
      return;
    }
    if (popOutMode(host) === 'document_pip') {
      try {
        const root = document.documentElement;
        const theme = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        const pip = await host.documentPictureInPicture!.requestWindow(requestedPipSize(readCollapsed(window.localStorage)));
        pip.document.open();
        pip.document.write(pipDocumentHtml(popOutUrl({ date, user, event, host: 'pip' }), { theme, background: getComputedStyle(root).getPropertyValue('--bg-canvas') }));
        pip.document.close();
        winRef.current = pip;
        setNote(null);
        return;
      } catch (err) {
        // A user gesture is required; a refused request is named and the panel takes over.
        const message = err instanceof Error ? err.message : String(err);
        console.error('[companion pop-out] floating window refused:', message);
        setNote(`Floating window refused (${message}) — showing the brief in this tab instead.`);
      }
    }
    openPanel();
  };

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button size={size} variant="primary" icon={PictureInPicture2} onClick={open}>
        Pop out
      </Button>
      {note && (
        <span role="status" className="text-[11px] text-right max-w-[260px]" style={{ color: 'var(--warning)' }}>
          {note}
        </span>
      )}
      {panelOpen && <FloatingPanel date={date} user={user} event={event} onClose={closePanel} />}
    </span>
  );
};
