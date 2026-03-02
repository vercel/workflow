'use client';

import {
  AnimatePresence,
  type AnimatePresenceProps,
  motion,
  type Transition,
  type Variants,
} from 'motion/react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

type WorkflowLog = {
  duration: number;
  text: string;
};

export type WorkflowLogsProps = {
  logs: WorkflowLog[];
  className?: string;
  transition?: Transition;
  variants?: Variants;
  onIndexChange?: (index: number) => void;
  trigger?: boolean;
  mode?: AnimatePresenceProps['mode'];
};

export function WorkflowLogs({
  logs,
  className,
  transition = { duration: 0.3 },
  variants,
  onIndexChange,
  trigger = true,
  mode = 'popLayout',
}: WorkflowLogsProps) {
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (!trigger || currentIndex >= logs.length) return;

    const currentLog = logs[currentIndex];

    const timer = setTimeout(() => {
      const nextIndex = currentIndex + 1;

      if (nextIndex < logs.length) {
        onIndexChange?.(nextIndex);
        setCurrentIndex(nextIndex);
      }
    }, currentLog.duration);

    return () => clearTimeout(timer);
  }, [currentIndex, logs, onIndexChange, trigger]);

  const motionVariants: Variants = {
    initial: { y: 20, opacity: 0 },
    animate: { y: 0, opacity: 1 },
    exit: { y: -20, opacity: 0 },
  };

  if (currentIndex >= logs.length) {
    return null;
  }

  const currentText = logs[currentIndex].text;
  const hasError =
    currentText.toLowerCase().includes('error') ||
    currentText.toLowerCase().includes('failed');

  return (
    <div
      className={cn(
        'relative inline-block whitespace-nowrap w-full border-t',
        'overflow-x-auto p-4 font-mono text-sm text-muted-foreground absolute bottom-0 right-0 left-0',
        hasError && 'bg-destructive/10',
        className
      )}
    >
      <AnimatePresence mode={mode} initial={false}>
        <motion.div
          key={currentIndex}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={transition}
          variants={variants || motionVariants}
          className={cn(hasError && 'text-destructive')}
        >
          {currentText}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
