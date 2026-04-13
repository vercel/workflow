'use client';

import type { JSX } from 'react';
import {
  motion,
  useMotionValue,
  useTransform,
  animate,
  useInView,
  useReducedMotion,
} from 'motion/react';
import { useEffect, useRef, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';

const ANIMATION_CONFIG = {
  STAGGER_DELAY: 200,
  ANIMATION_DURATION: 1500,
  GRADIENT_FADE_DELAY: 300,
  FADE_OUT_DELAY: 800,
  FADE_OUT_DURATION: 500,
  PAUSE_DURATION: 1000,
  TOTAL_CYCLE_TIME: 4800,
  COLOR_CHANGE_THRESHOLD: { RED: 60, GREEN: 80 },
} as const;

const ANIMATION_LINES = Array.from({ length: 7 }, (_, index) => ({
  id: `line-${index}`,
  delay: index * ANIMATION_CONFIG.STAGGER_DELAY,
}));

export function AgentsVisual(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref);
  const shouldReduceMotion = useReducedMotion();
  const [animationKey, setAnimationKey] = useState(0);

  const startAnimationCycle = useCallback(() => {
    if (shouldReduceMotion) return;

    setAnimationKey((prev) => prev + 1);
  }, [shouldReduceMotion]);

  useEffect(() => {
    if (!isInView || shouldReduceMotion) return;

    let intervalId: NodeJS.Timeout;

    const scheduleNextCycle = () => {
      intervalId = setTimeout(() => {
        if (isInView && !shouldReduceMotion) {
          startAnimationCycle();
          scheduleNextCycle();
        }
      }, ANIMATION_CONFIG.TOTAL_CYCLE_TIME);
    };

    startAnimationCycle();
    scheduleNextCycle();

    return () => {
      clearTimeout(intervalId);
    };
  }, [isInView, shouldReduceMotion, startAnimationCycle]);

  return (
    <div
      ref={ref}
      className="aspect-[444/264] w-full max-w-[444px] mx-auto relative overflow-hidden"
      role="img"
      aria-label="Animated workflow visualization showing progressive completion of tasks"
    >
      <div className="w-[calc(100%-10px)] h-full flex flex-col justify-between py-[5px]">
        {ANIMATION_LINES.map((line) => (
          <AnimatedLine
            key={line.id}
            delay={line.delay}
            animationKey={animationKey}
            shouldReduceMotion={shouldReduceMotion}
          />
        ))}
      </div>
      <div className="w-[35%] h-full absolute top-0 left-0 bg-gradient-to-r from-background-200 to-transparent pointer-events-none" />
    </div>
  );
}

interface AnimatedLineProps {
  delay: number;
  animationKey: number;
  shouldReduceMotion: boolean | null;
}

function AnimatedLine({
  delay,
  animationKey,
  shouldReduceMotion,
}: AnimatedLineProps): JSX.Element {
  const width = useMotionValue(0);
  const widthPct = useTransform(width, (v) => `${v}%`);
  const opacity = useMotionValue(1);
  const [hideGradient, setHideGradient] = useState(false);
  const [gradientColor, setGradientColor] = useState<'red' | 'green'>('green');

  useEffect(() => {
    if (shouldReduceMotion) {
      width.set(100);
      opacity.set(1);
      setHideGradient(true);
      setGradientColor('green');
      return;
    }

    setHideGradient(false);
    width.set(0);
    opacity.set(1);

    const widthControls = animate(width, 100, {
      duration: ANIMATION_CONFIG.ANIMATION_DURATION / 1000,
      delay: delay / 1000,
      ease: [0.4, 0.04, 0.04, 1],
    });

    const timeoutIds: NodeJS.Timeout[] = [];

    const unsubscribe = width.on('change', (latest) => {
      if (
        latest > ANIMATION_CONFIG.COLOR_CHANGE_THRESHOLD.RED &&
        latest < ANIMATION_CONFIG.COLOR_CHANGE_THRESHOLD.GREEN
      ) {
        setGradientColor('red');
      }
      if (latest >= ANIMATION_CONFIG.COLOR_CHANGE_THRESHOLD.GREEN) {
        setGradientColor('green');
      }
    });

    void widthControls.finished.then(() => {
      const timeout1 = setTimeout(
        () => setHideGradient(true),
        ANIMATION_CONFIG.GRADIENT_FADE_DELAY
      );
      const timeout2 = setTimeout(
        () => setGradientColor('green'),
        ANIMATION_CONFIG.GRADIENT_FADE_DELAY * 2
      );

      timeoutIds.push(timeout1, timeout2);

      animate(opacity, 0, {
        duration: ANIMATION_CONFIG.FADE_OUT_DURATION / 1000,
        delay: ANIMATION_CONFIG.FADE_OUT_DELAY / 1000,
        ease: [0.4, 0.04, 0.04, 1],
      });
    });

    return () => {
      widthControls.stop();
      unsubscribe();
      timeoutIds.forEach(clearTimeout);
    };
  }, [animationKey, width, opacity, delay, shouldReduceMotion]);

  return (
    <div className="w-full relative text-gray-600">
      <DashedLine />
      <motion.div
        style={{
          width: widthPct,
          opacity: opacity,
        }}
        className="absolute top-0 left-0 overflow-hidden"
      >
        <div className="w-full">
          <SolidLine />
          <GradientLine color={gradientColor} hideGradient={hideGradient} />
        </div>
      </motion.div>
      <Arrow />
    </div>
  );
}

function SolidLine(): JSX.Element {
  return <div className="w-full h-0.5 bg-gray-600" />;
}

function DashedLine(): JSX.Element {
  return (
    <svg
      className="w-full block"
      height="2"
      fill="none"
      viewBox="0 0 432 2"
      aria-hidden="true"
    >
      <path
        stroke="currentColor"
        strokeDasharray="4 4"
        strokeWidth="2"
        d="M432 1H0"
      />
    </svg>
  );
}

interface GradientLineProps {
  hideGradient: boolean;
  color?: 'green' | 'red';
}

function GradientLine({
  hideGradient,
  color = 'red',
}: GradientLineProps): JSX.Element {
  return (
    <div
      className={cn(
        'absolute top-0 right-0 w-12 h-0.5 transition-all duration-300',
        hideGradient && 'opacity-0',
        color === 'green' &&
          'bg-gradient-to-r from-gray-600 via-green-700 to-gray-600',
        color === 'red' &&
          'bg-gradient-to-r from-gray-600 via-red-700 to-gray-600'
      )}
    />
  );
}

function Arrow(): JSX.Element {
  return (
    <svg
      className="absolute top-1/2 -right-2.5 -translate-y-1/2"
      width="10"
      height="12"
      viewBox="0 0 10 12"
      fill="none"
      aria-hidden="true"
    >
      <path fill="currentColor" d="m0 12 10-6L0 0z" />
    </svg>
  );
}
