'use client';

import type { JSX } from 'react';
import { cn } from '@/lib/utils';
import { Bar } from './bar';
import {
  motion,
  useMotionValue,
  useTransform,
  animate,
  useReducedMotion,
} from 'motion/react';
import { useEffect, useState } from 'react';

export interface AnimatedBarProps {
  className?: string;
  counterFormat?: 'ms' | 's';
  delay: number;
  duration: number;
  ease?: string | number[];
  isInView: boolean;
  left?: string;
  onFinish?: () => void;
  right: string;
  shouldReduceMotion?: boolean | null;
  showLine?: boolean;
  size?: 'small' | 'large';
  targetValue: number;
  variant?: 'blue' | 'green' | 'amber';
}

export function AnimatedBar({
  className,
  counterFormat = 's',
  delay,
  duration,
  ease = 'linear',
  isInView,
  left,
  onFinish,
  right,
  shouldReduceMotion: shouldReduceMotionProp,
  showLine,
  size,
  targetValue,
  variant,
}: AnimatedBarProps): JSX.Element {
  const shouldReduceMotionHook = useReducedMotion();
  const shouldReduceMotion = shouldReduceMotionProp ?? shouldReduceMotionHook;

  const width = useMotionValue(0);
  const widthPct = useTransform(width, (v) => `${v}%`);
  const counter = useMotionValue(0);
  const [currentCounter, setCurrentCounter] = useState(0);
  const [hideLine, setHideLine] = useState(false);
  const [overflow, setOverflow] = useState<'visible' | 'hidden'>('hidden');

  useEffect(() => {
    const unsubscribe = counter.on('change', (latest) => {
      setCurrentCounter(latest);
    });
    return unsubscribe;
  }, [counter]);

  useEffect(() => {
    if (!isInView) return;

    if (shouldReduceMotion) {
      width.set(100);
      counter.set(targetValue);
      setCurrentCounter(targetValue);
      if (showLine) {
        setOverflow('visible');
        setHideLine(true);
      }
      onFinish?.();
      return;
    }

    if (showLine) {
      setOverflow('visible');
    }

    // @ts-expect-error - TODO: fix
    const controls = animate(width, 100, {
      duration: duration / 1000,
      delay: delay / 1000,
      ease,
    });

    // @ts-expect-error - TODO: fix
    const counterControls = animate(counter, targetValue, {
      duration: duration / 1000,
      delay: delay / 1000,
      ease,
    });

    void Promise.all([controls.finished, counterControls.finished]).then(() => {
      setHideLine(true);
      onFinish?.();
    });

    return () => {
      controls.stop();
      counterControls.stop();
    };
  }, [
    isInView,
    width,
    counter,
    delay,
    duration,
    targetValue,
    ease,
    onFinish,
    showLine,
    shouldReduceMotion,
  ]);

  return (
    <motion.div
      style={{
        width: widthPct,
        overflow,
      }}
      className="h-full relative"
    >
      <Bar
        left={left}
        right={
          currentCounter
            ? counterFormat === 'ms'
              ? `${Math.round(currentCounter)}ms`
              : `${Math.round(currentCounter / 1000)}s`
            : right
        }
        variant={variant}
        size={size}
        className={className}
      />
      {showLine && (
        <div
          className={cn(
            '-right-px absolute -top-1/2 h-[100vh] w-px opacity-100 transition-opacity duration-300',
            'bg-[linear-gradient(180deg,_var(--ds-background-200)_0%,_var(--ds-green-700)_15%)]',
            hideLine && 'opacity-0'
          )}
        />
      )}
    </motion.div>
  );
}
