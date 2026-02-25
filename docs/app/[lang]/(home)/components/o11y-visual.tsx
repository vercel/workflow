'use client';

import type { JSX } from 'react';
import { cn } from '@/lib/utils';
import {
  motion,
  useMotionValue,
  useTransform,
  animate,
  useInView,
  AnimatePresence,
  useReducedMotion,
} from 'motion/react';
import { useEffect, useRef, useState, useCallback } from 'react';

const ANIMATION_CONFIG = {
  DURATION: 2000,
  EASE: 'linear' as const,
  TIMING_RATIOS: {
    FETCH_ORDER: 0.25,
    VALIDATE: 0.1666,
    ENRICH_PRICING: 0.25,
    SAVE_ORDER: 0.1666,
    SEND_EMAIL: 0.1666,
  },
  DELAY_RATIOS: {
    VALIDATE: 0.25,
    ENRICH_PRICING: 0.4166,
    SAVE_ORDER: 0.6666,
    SEND_EMAIL: 0.8332,
  },
} as const;

const GRID_LINES = Array.from({ length: 15 }, (_, index) => ({
  id: `grid-line-${index}`,
  isVisible: index !== 0 && index !== 14,
}));

export function O11yVisual(): JSX.Element {
  const [isFinished, setIsFinished] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref);
  const shouldReduceMotion = useReducedMotion();

  const handleFinish = useCallback(() => {
    setIsFinished(true);
  }, []);

  return (
    <div
      ref={ref}
      className="@container w-full relative pb-4 md:pb-8 lg:pb-[90px]"
      role="img"
      aria-label="Performance visualization showing workflow execution timeline with nested function calls"
    >
      <div className="absolute inset-0 flex justify-between" aria-hidden="true">
        {GRID_LINES.map((line) => (
          <div
            key={line.id}
            className={cn(
              'h-full w-px',
              'bg-gradient-to-b from-transparent to-border',
              !line.isVisible && 'opacity-0'
            )}
          />
        ))}
      </div>

      <div className="grid relative grid-cols-[repeat(14,_1fr)] grid-rows-[1fr] gap-0 mb-4 pt-px">
        <div className="row-start-[1] col-start-[2] row-end-[2] col-end-[14] bg-card border rounded-md flex justify-between">
          <div className="flex items-center px-2.5 py-2 gap-4">
            <div className="flex flex-col gap-0.5 min-w-[80px]">
              <span className="text-xs text-muted-foreground">Status</span>
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'size-1.5 flex-none rounded-full',
                    !shouldReduceMotion && 'transition-colors',
                    isFinished ? 'bg-cyan-500' : 'bg-amber-500'
                  )}
                />
                <span className="text-xs overflow-hidden">
                  {shouldReduceMotion ? (
                    <span>{isFinished ? 'Completed' : 'Running'}</span>
                  ) : (
                    <AnimatePresence mode="wait">
                      {isFinished ? (
                        <motion.span
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          key="completed"
                        >
                          Completed
                        </motion.span>
                      ) : (
                        <motion.span
                          initial={{ opacity: 1 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          key="running"
                        >
                          Running
                        </motion.span>
                      )}
                    </AnimatePresence>
                  )}
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-xs text-muted-foreground">Run ID</span>
              <span className="text-xs truncate">wrun_02456KXR</span>
            </div>
          </div>
          <div className="flex flex-col gap-0.5 px-2.5 py-2 text-right">
            <span className="text-xs text-muted-foreground">Duration</span>
            <span className="text-xs">
              <Counter
                duration={ANIMATION_CONFIG.DURATION}
                onFinish={handleFinish}
                targetValue={925}
                isInView={isInView}
                shouldReduceMotion={shouldReduceMotion}
              />
            </span>
          </div>
        </div>
      </div>

      <div className="relative grid grid-rows-6 grid-cols-[repeat(14,_minmax(0,_1fr))] gap-y-1">
        <div className="row-start-[1] col-start-[2] row-end-[2] col-end-[14]">
          <AnimatedBar
            delay={0}
            duration={ANIMATION_CONFIG.DURATION}
            left="workflow()"
            right="925ms"
            targetValue={925}
            isInView={isInView}
            ease={ANIMATION_CONFIG.EASE}
            counterFormat="ms"
            shouldReduceMotion={shouldReduceMotion}
            showLine
          />
        </div>
        <div className="row-start-[2] col-start-[2] row-end-[3] col-end-[6] xl:col-end-[5]">
          <AnimatedBar
            variant="green"
            left="fetchOrder()"
            right="230ms"
            delay={0}
            duration={
              ANIMATION_CONFIG.DURATION *
              ANIMATION_CONFIG.TIMING_RATIOS.FETCH_ORDER
            }
            targetValue={230}
            isInView={isInView}
            ease={ANIMATION_CONFIG.EASE}
            counterFormat="ms"
            shouldReduceMotion={shouldReduceMotion}
          />
        </div>
        <div className="row-start-[3] col-start-[5] row-end-[4] col-end-[8] xl:col-end-[7]">
          <AnimatedBar
            variant="green"
            left="validate()"
            right="155ms"
            delay={
              ANIMATION_CONFIG.DURATION * ANIMATION_CONFIG.DELAY_RATIOS.VALIDATE
            }
            duration={
              ANIMATION_CONFIG.DURATION *
              ANIMATION_CONFIG.TIMING_RATIOS.VALIDATE
            }
            targetValue={155}
            isInView={isInView}
            ease={ANIMATION_CONFIG.EASE}
            counterFormat="ms"
            shouldReduceMotion={shouldReduceMotion}
          />
        </div>
        <div className="row-start-[4] col-start-[7] row-end-[5] col-end-[11] xl:col-end-[10]">
          <AnimatedBar
            variant="green"
            left="enrichWithPricing()"
            right="230ms"
            delay={
              ANIMATION_CONFIG.DURATION *
              ANIMATION_CONFIG.DELAY_RATIOS.ENRICH_PRICING
            }
            duration={
              ANIMATION_CONFIG.DURATION *
              ANIMATION_CONFIG.TIMING_RATIOS.ENRICH_PRICING
            }
            targetValue={230}
            isInView={isInView}
            ease={ANIMATION_CONFIG.EASE}
            counterFormat="ms"
            shouldReduceMotion={shouldReduceMotion}
          />
        </div>
        <div className="row-start-[5] col-start-[10] row-end-[6] col-end-[13] xl:col-end-[12]">
          <AnimatedBar
            variant="green"
            left="saveOrder()"
            right="155ms"
            delay={
              ANIMATION_CONFIG.DURATION *
              ANIMATION_CONFIG.DELAY_RATIOS.SAVE_ORDER
            }
            duration={
              ANIMATION_CONFIG.DURATION *
              ANIMATION_CONFIG.TIMING_RATIOS.SAVE_ORDER
            }
            targetValue={155}
            isInView={isInView}
            ease={ANIMATION_CONFIG.EASE}
            counterFormat="ms"
            shouldReduceMotion={shouldReduceMotion}
          />
        </div>
        <div className="row-start-[6] col-start-[11] xl:col-start-[12] row-end-[7] col-end-[14]">
          <AnimatedBar
            variant="green"
            left="sendEmail()"
            right="155ms"
            delay={
              ANIMATION_CONFIG.DURATION *
              ANIMATION_CONFIG.DELAY_RATIOS.SEND_EMAIL
            }
            duration={
              ANIMATION_CONFIG.DURATION *
              ANIMATION_CONFIG.TIMING_RATIOS.SEND_EMAIL
            }
            targetValue={155}
            isInView={isInView}
            ease={ANIMATION_CONFIG.EASE}
            counterFormat="ms"
            shouldReduceMotion={shouldReduceMotion}
          />
        </div>
      </div>
    </div>
  );
}

// --- AnimatedBar ---

interface AnimatedBarProps {
  className?: string;
  counterFormat?: 'ms' | 's';
  delay: number;
  duration: number;
  ease?: string | number[];
  isInView: boolean;
  left?: string;
  right: string;
  shouldReduceMotion?: boolean | null;
  showLine?: boolean;
  targetValue: number;
  variant?: 'blue' | 'green' | 'amber';
}

function AnimatedBar({
  className,
  counterFormat = 's',
  delay,
  duration,
  ease = 'linear',
  isInView,
  left,
  right,
  shouldReduceMotion: shouldReduceMotionProp,
  showLine,
  targetValue,
  variant,
}: AnimatedBarProps): JSX.Element {
  const shouldReduceMotionHook = useReducedMotion();
  const shouldReduceMotion = shouldReduceMotionProp ?? shouldReduceMotionHook;

  const width = useMotionValue(0);
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
      return;
    }

    if (showLine) {
      setOverflow('visible');
    }

    // @ts-expect-error motion type mismatch
    const controls = animate(width, 100, {
      duration: duration / 1000,
      delay: delay / 1000,
      ease,
    });

    // @ts-expect-error motion type mismatch
    const counterControls = animate(counter, targetValue, {
      duration: duration / 1000,
      delay: delay / 1000,
      ease,
    });

    void Promise.all([controls.finished, counterControls.finished]).then(() => {
      setHideLine(true);
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
    showLine,
    shouldReduceMotion,
  ]);

  const formattedCounter = currentCounter
    ? counterFormat === 'ms'
      ? `${Math.round(currentCounter)}ms`
      : `${Math.round(currentCounter / 1000)}s`
    : right;

  return (
    <motion.div
      style={{
        width: useTransform(width, (v) => `${v}%`),
        overflow,
      }}
      className="h-full relative"
    >
      <Bar
        left={left}
        right={formattedCounter}
        variant={variant}
        className={className}
      />
      {showLine && (
        <div
          className={cn(
            '-right-px absolute -top-1/2 h-[100vh] w-px opacity-100 transition-opacity duration-300',
            'bg-gradient-to-b from-transparent to-green-600',
            hideLine && 'opacity-0'
          )}
        />
      )}
    </motion.div>
  );
}

// --- Bar ---

const barVariants = {
  blue: 'bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300 border-blue-300 dark:border-blue-800',
  green:
    'bg-green-100 dark:bg-green-950 text-green-800 dark:text-green-300 border-green-300 dark:border-green-800',
  amber:
    'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-800',
};

function Bar({
  left,
  right,
  variant = 'blue',
  className,
}: {
  left?: string;
  right: string;
  variant?: 'blue' | 'green' | 'amber';
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center border rounded-sm py-1 px-2 text-xs font-mono',
        left ? 'justify-between' : 'justify-center',
        barVariants[variant],
        className
      )}
    >
      {left ? <div className="min-w-0 truncate">{left}</div> : null}
      <div>{right}</div>
    </div>
  );
}

// --- Counter ---

interface CounterProps {
  duration: number;
  onFinish?: () => void;
  targetValue: number;
  isInView: boolean;
  shouldReduceMotion?: boolean | null;
}

function Counter({
  duration,
  onFinish,
  targetValue,
  isInView,
  shouldReduceMotion,
}: CounterProps): JSX.Element {
  const counter = useMotionValue(0);
  const [currentCounter, setCurrentCounter] = useState(0);

  useEffect(() => {
    const unsubscribe = counter.on('change', (latest) => {
      setCurrentCounter(latest);
    });
    return unsubscribe;
  }, [counter]);

  useEffect(() => {
    if (!isInView) return;

    if (shouldReduceMotion) {
      counter.set(targetValue);
      setCurrentCounter(targetValue);
      onFinish?.();
      return;
    }

    const counterControls = animate(counter, targetValue, {
      duration: duration / 1000,
      ease: ANIMATION_CONFIG.EASE,
    });

    if (onFinish) {
      void counterControls.finished.then(() => onFinish());
    }

    return () => {
      counterControls.stop();
    };
  }, [isInView, counter, duration, targetValue, onFinish, shouldReduceMotion]);

  return <span>{Math.round(currentCounter)}ms</span>;
}
