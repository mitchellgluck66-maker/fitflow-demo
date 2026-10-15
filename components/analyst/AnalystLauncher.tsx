'use client';

import { FlynnOrb } from './FlynnOrb';
import { useAnalystOptional } from './AnalystProvider';

/** The floating orb (docs/fitflow-analyst-demo.html): 64 px, drifting, tooltip "Ask FitFlow Analyst"; hidden while the panel is open. */
export function AnalystLauncher() {
  const a = useAnalystOptional();
  if (!a) return null;
  return (
    <button ref={a.launcherRef} type="button" className="analyst-launch" aria-label="Open FitFlow Analyst" onClick={a.open} data-open={a.isOpen ? 'true' : 'false'}>
      <FlynnOrb size={64} particles={140} speed={a.busy ? 2.4 : 1} />
      <span className="analyst-launch-tip">Ask FitFlow Analyst</span>
    </button>
  );
}
