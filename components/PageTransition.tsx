'use client';

import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

interface PageTransitionProps {
  children: React.ReactNode;
}

/**
 * Subtle route transition: 4px rise + fade in ≤150ms. Under
 * prefers-reduced-motion it renders children with no animation at all.
 */
export const PageTransition: React.FC<PageTransitionProps> = ({ children }) => {
  const reduced = useReducedMotion();
  if (reduced) return <>{children}</>;
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}>
      {children}
    </motion.div>
  );
};

export default PageTransition;
