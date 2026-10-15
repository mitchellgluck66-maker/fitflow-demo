'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';

/** The demo's composer: an auto-growing textarea, Enter sends (Shift+Enter breaks), chips for the model and the period, Send becomes Stop while a turn runs. */
export function Composer({ onSend, onStop, busy, modelChip, periodChip, disabled, autoFocus }: { onSend: (text: string) => void; onStop: () => void; busy: boolean; modelChip: string; periodChip: string | null; disabled?: boolean; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);
  useEffect(() => {
    if (autoFocus) setTimeout(() => ref.current?.focus({ preventScroll: true }), 450);
  }, [autoFocus]);
  const send = () => {
    const q = text.trim();
    if (!q || busy || disabled) return;
    setText('');
    onSend(q);
  };
  return (
    <div className="analyst-composer">
      <div className="analyst-box">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={disabled ? 'Connect the Analyst in Setup to ask…' : 'Ask about your business…'}
          disabled={disabled}
          aria-label="Ask the Analyst"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="analyst-box-row">
          <span className="analyst-chip">{modelChip}</span>
          {periodChip ? <span className="analyst-chip">{periodChip}</span> : null}
          {busy ? (
            <button type="button" className="analyst-send is-stop" onClick={onStop} aria-label="Stop" title="Stop">
              <Square size={14} strokeWidth={2.4} />
            </button>
          ) : (
            <button type="button" className="analyst-send" onClick={send} disabled={!text.trim() || disabled} aria-label="Send">
              <ArrowUp size={16} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
      <div className="analyst-fine">Every number is checked against your dashboard before it&rsquo;s shown.</div>
    </div>
  );
}
