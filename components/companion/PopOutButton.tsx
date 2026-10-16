'use client';

import React, { useRef, useState } from 'react';
import { PictureInPicture2 } from 'lucide-react';
import { Button } from '@/components';
import { POPOUT_HEIGHT, POPOUT_WIDTH, pipDocumentHtml, popOutMode, popOutUrl, popupFeatures, type DocumentPipHost } from '@/lib/companion/popout';

/**
 * "Pop out": a Document Picture-in-Picture window (Chrome 116+) holding /companion/popout, always on top; elsewhere
 * a plain popup of the same page, which then says it cannot float. One window at a time — a second click focuses it.
 */
export const PopOutButton: React.FC<{ date: string | null; user: string | null; event?: string | null; size?: 'sm' | 'md' }> = ({ date, user, event, size = 'sm' }) => {
  const [note, setNote] = useState<string | null>(null);
  const winRef = useRef<Window | null>(null);

  const open = async () => {
    const host = window as unknown as DocumentPipHost;
    const mode = popOutMode(host);
    const url = popOutUrl({ date, user, event, mode });
    if (winRef.current && !winRef.current.closed) {
      winRef.current.focus();
      return;
    }
    if (mode === 'document_pip') {
      try {
        const pip = await host.documentPictureInPicture!.requestWindow({ width: POPOUT_WIDTH, height: POPOUT_HEIGHT });
        pip.document.open();
        pip.document.write(pipDocumentHtml(url));
        pip.document.close();
        winRef.current = pip;
        setNote(null);
        return;
      } catch (err) {
        // A user gesture is required; a denied request falls through to the plain window.
        setNote(err instanceof Error ? err.message : String(err));
      }
    }
    const w = window.open(popOutUrl({ date, user, event, mode: 'window' }), 'fitflow-companion-popout', popupFeatures());
    if (!w) setNote('The browser blocked the pop-out window — allow pop-ups for this site.');
    else winRef.current = w;
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
    </span>
  );
};
