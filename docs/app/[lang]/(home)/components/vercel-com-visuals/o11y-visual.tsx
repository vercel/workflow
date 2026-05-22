'use client';

import type { JSX } from 'react';
import { AnimatedBar } from './animated-bar';
import { cn } from '@/lib/utils';
import {
  motion,
  useMotionValue,
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
      className="@container w-full relative"
      role="img"
      aria-label="Performance visualization showing workflow execution timeline with nested function calls"
    >
      <div className="absolute inset-0 flex justify-between" aria-hidden="true">
        {GRID_LINES.map((line) => (
          <div
            key={line.id}
            className={cn(
              'h-full w-px bg-[var(--guide-color)]',
              'bg-[linear-gradient(180deg,_var(--ds-background-200)_0%,_var(--guide-color)_75%)]',
              !line.isVisible && 'opacity-0'
            )}
          />
        ))}
      </div>

      <div className="grid relative grid-cols-[repeat(14,_1fr)] grid-rows-[1fr] gap-0 mb-4 pt-px">
        <div className="row-start-[1] col-start-[2] row-end-[2] col-end-[14] material-small rounded-md flex justify-between">
          <div className="flex items-center px-2.5 py-2 gap-4">
            <div className="flex flex-col gap-0.5 min-w-[80px]">
              <span className="text-label-13 text-gray-900">Status</span>
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'size-1.5 flex-none rounded-full',
                    !shouldReduceMotion && 'transition-colors',
                    isFinished ? 'bg-geist-cyan' : 'bg-geist-warning'
                  )}
                />
                <span className="text-label-13 overflow-hidden">
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
              <span className="text-label-13 text-gray-900">Run ID</span>
              <span className="text-label-13 truncate">wrun_02456KXR</span>
            </div>
          </div>
          <div className="flex flex-col gap-0.5 px-2.5 py-2 text-right">
            <span className="text-label-13 text-gray-900">Duration</span>
            <span className="text-label-13">
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
