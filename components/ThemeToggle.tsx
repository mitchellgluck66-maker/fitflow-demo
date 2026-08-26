'use client';

import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from './ThemeProvider';

/**
 * Light/dark switch.
 *
 * Both icons are always mounted and cross-faded with a rotation, so the change
 * reads as one object turning rather than two icons swapping - the same
 * treatment native macOS controls use.
 */
export const ThemeToggle: React.FC<{ className?: string }> = ({ className }) => {
  const { theme, toggle } = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      className={`relative h-8 w-8 grid place-items-center rounded-[7px] border transition-all duration-150 active:scale-95 ${className ?? ''}`}
      style={{
        background: 'var(--surface)',
        borderColor: 'var(--border-subtle)',
        boxShadow: 'var(--shadow-xs), inset 0 1px 0 0 var(--border-highlight)',
      }}
    >
      <Sun
        size={15}
        strokeWidth={2}
        className="absolute transition-all duration-300"
        style={{
          color: 'var(--text-secondary)',
          opacity: isDark ? 0 : 1,
          transform: isDark ? 'rotate(-90deg) scale(0.5)' : 'rotate(0) scale(1)',
        }}
      />
      <Moon
        size={15}
        strokeWidth={2}
        className="absolute transition-all duration-300"
        style={{
          color: 'var(--text-secondary)',
          opacity: isDark ? 1 : 0,
          transform: isDark ? 'rotate(0) scale(1)' : 'rotate(90deg) scale(0.5)',
        }}
      />
    </button>
  );
};
