'use client';

import type { JSX } from 'react';
import { AnimatedBar } from './animated-bar';
import { useInView, useReducedMotion } from 'motion/react';
import { useRef } from 'react';

const ANIMATION_CONFIG = {
  DURATION: 1250,
  EASE: 'linear' as const,
  TIMING_RATIOS: {
    STEP_1: 0.245,
    STEP_2: 0.367,
    STEP_3: 0.141,
    STEP_4: 0.247,
  },
  DELAY_RATIOS: {
    STEP_2: 0.245,
    STEP_3: 0.612,
    STEP_4: 0.753,
  },
} as const;

const GRID_LINES = Array.from({ length: 6 }, (_, index) => ({
  id: `grid-line-${index}`,
}));

export function TimeoutVisual(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref);
  const shouldReduceMotion = useReducedMotion();

  return (
    <div
      ref={ref}
      className="aspect-[444/264] w-full max-w-[444px] mx-auto relative overflow-hidden"
      role="img"
      aria-label="Workflow timeout visualization showing function execution and waiting periods"
    >
      <div
        className="absolute inset-0 flex flex-col justify-between"
        aria-hidden="true"
      >
        {GRID_LINES.map((line) => (
          <div key={line.id} className="w-full h-px bg-[var(--guide-color)]" />
        ))}
      </div>
      <div className="relative w-full h-full grid grid-cols-[repeat(8,_1fr)] grid-rows-[repeat(5,_1fr)] gap-0">
        <div className="row-start-[1] col-start-[1] row-end-[2] col-end-[9] flex items-center py-[3px]">
          <AnimatedBar
            className="w-full h-full !py-0"
            size="large"
            variant="blue"
            left="workflowTrigger()"
            right="10s"
            delay={0}
            duration={ANIMATION_CONFIG.DURATION}
            targetValue={58000}
            isInView={isInView}
            ease={ANIMATION_CONFIG.EASE}
            shouldReduceMotion={shouldReduceMotion}
            showLine
          />
        </div>
        <div className="row-start-[2] col-start-[1] row-end-[3] col-end-[3] flex items-center py-[3px]">
          <AnimatedBar
            className="w-full h-full !py-0"
            size="large"
            variant="green"
            right="230ms"
            delay={0}
            targetValue={14000}
            duration={
              ANIMATION_CONFIG.DURATION * ANIMATION_CONFIG.TIMING_RATIOS.STEP_1
            }
            isInView={isInView}
            ease={ANIMATION_CONFIG.EASE}
            shouldReduceMotion={shouldReduceMotion}
          />
        </div>
        <div className="row-start-[3] col-start-[3] row-end-[4] col-end-[6] flex items-center py-[3px]">
          <AnimatedBar
            left="waiting"
            className="w-full h-full !py-0"
            size="large"
            right="155ms"
            delay={
              ANIMATION_CONFIG.DURATION * ANIMATION_CONFIG.DELAY_RATIOS.STEP_2
            }
            duration={
              ANIMATION_CONFIG.DURATION * ANIMATION_CONFIG.TIMING_RATIOS.STEP_2
            }
            targetValue={21000}
            variant="amber"
            isInView={isInView}
            ease={ANIMATION_CONFIG.EASE}
            shouldReduceMotion={shouldReduceMotion}
          />
        </div>
        <div className="row-start-[4] col-start-[6] row-end-[5] col-end-[7] flex items-center py-[3px]">
          <AnimatedBar
            className="w-full h-full !py-0"
            size="large"
            right="1s"
            variant="green"
            delay={
              ANIMATION_CONFIG.DURATION * ANIMATION_CONFIG.DELAY_RATIOS.STEP_3
            }
            duration={
              ANIMATION_CONFIG.DURATION * ANIMATION_CONFIG.TIMING_RATIOS.STEP_3
            }
            targetValue={8000}
            isInView={isInView}
            ease={ANIMATION_CONFIG.EASE}
            shouldReduceMotion={shouldReduceMotion}
          />
        </div>
        <div className="row-start-[5] col-start-[7] row-end-[6] col-end-[9] flex items-center py-[3px]">
          <AnimatedBar
            className="w-full h-full !py-0"
            size="large"
            right="1s"
            variant="green"
            delay={
              ANIMATION_CONFIG.DURATION * ANIMATION_CONFIG.DELAY_RATIOS.STEP_4
            }
            duration={
              ANIMATION_CONFIG.DURATION * ANIMATION_CONFIG.TIMING_RATIOS.STEP_4
            }
            targetValue={14000}
            isInView={isInView}
            ease={ANIMATION_CONFIG.EASE}
            shouldReduceMotion={shouldReduceMotion}
          />
        </div>
      </div>
    </div>
  );
}
