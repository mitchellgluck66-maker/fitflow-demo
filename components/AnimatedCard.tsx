import React from 'react';
import { motion } from 'framer-motion';
import { Card, CardProps } from './Card';

interface AnimatedCardProps extends CardProps {
  delay?: number;
  animation?: 'fadeIn' | 'slideUp' | 'scaleIn';
}

const animationVariants = {
  fadeIn: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
  },
  slideUp: {
    initial: { opacity: 0, y: 20 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 20 },
  },
  scaleIn: {
    initial: { opacity: 0, scale: 0.95 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.95 },
  },
};

export const AnimatedCard: React.FC<AnimatedCardProps> = ({
  children,
  delay = 0,
  animation = 'slideUp',
  ...props
}) => {
  const variant = animationVariants[animation];

  return (
    <motion.div
      initial={variant.initial}
      animate={variant.animate}
      exit={variant.exit}
      transition={{
        duration: 0.3,
        delay,
        ease: [0.4, 0, 0.2, 1],
      }}
    >
      <Card {...props}>{children}</Card>
    </motion.div>
  );
};

export default AnimatedCard;
