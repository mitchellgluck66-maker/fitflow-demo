import React from 'react';
import { motion } from 'framer-motion';
import { Badge, BadgeProps } from './Badge';

type AnimatedBadgeProps = BadgeProps & {
  delay?: number;
};

export const AnimatedBadge: React.FC<AnimatedBadgeProps> = ({
  children,
  delay = 0,
  ...props
}) => {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{
        duration: 0.2,
        delay,
        ease: 'easeOut',
      }}
    >
      <Badge {...props}>{children}</Badge>
    </motion.div>
  );
};

export default AnimatedBadge;
