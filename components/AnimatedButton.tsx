import React from 'react';
import { motion } from 'framer-motion';
import { Button, ButtonProps } from './Button';

type AnimatedButtonProps = ButtonProps & {
  delay?: number;
};

export const AnimatedButton: React.FC<AnimatedButtonProps> = ({
  children,
  delay = 0,
  onClick,
  ...props
}) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.3,
        delay,
        ease: [0.4, 0, 0.2, 1],
      }}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
    >
      <Button onClick={onClick} {...props}>
        {children}
      </Button>
    </motion.div>
  );
};

export default AnimatedButton;
