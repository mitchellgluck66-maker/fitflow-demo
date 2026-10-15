'use client';

import { useEffect, useState } from 'react';
import { FlynnOrb } from './FlynnOrb';

/** The demo's thinking state: a living 40 px orb with a halo, the shimmering "Thinking", and a sub-line that fades between live statuses. No typing dots. */
export function ThinkingState({ status }: { status: string }) {
  const [shown, setShown] = useState(status);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (status === shown) return;
    setVisible(false);
    const t = setTimeout(() => {
      setShown(status);
      setVisible(true);
    }, 300);
    return () => clearTimeout(t);
  }, [status, shown]);
  return (
    <div className="analyst-thinking" role="status" aria-live="polite" data-testid="analyst-thinking">
      <div className="analyst-think-orb">
        <FlynnOrb size={40} particles={110} speed={2.4} />
      </div>
      <div>
        <div className="analyst-think-text">Thinking</div>
        <div className="analyst-think-sub" style={{ opacity: visible ? 1 : 0 }}>
          {shown}
        </div>
      </div>
    </div>
  );
}
