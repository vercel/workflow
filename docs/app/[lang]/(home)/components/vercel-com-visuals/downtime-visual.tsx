'use client';

import type { JSX } from 'react';
import { cn } from '@/lib/utils';
import { useState, useEffect, useRef } from 'react';
import { AnimatePresence, motion, useInView } from 'motion/react';
import { Spinner } from '@/components/ui/spinner';

export function DowntimeVisual(): JSX.Element {
  return (
    <div className="aspect-[444/264] w-full max-w-[444px] mx-auto relative overflow-hidden p-px">
      <div className="w-full h-full material-small rounded-md rounded-b-none">
        <Item title="VGxkwTd46" subtitle="Preview" />
        <Item title="GFsdgf33w" subtitle="Production" seconds="56s" />
        <Item title="REsdf2dsx" subtitle="Preview" seconds="49s" />
        <Item title="LDDgfrT21" subtitle="Production" seconds="59s" />
      </div>
      <div className="w-full h-[35%] absolute bottom-0 left-0 bg-gradient-to-t from-background-200 to-transparent" />
    </div>
  );
}

type ItemProps = {
  title: string;
  subtitle: string;
  seconds?: string;
};

function Item({ title, subtitle, seconds }: ItemProps) {
  const [inView, setInView] = useState(false);
  const [isFinished, setIsFinished] = useState(Boolean(seconds));
  const [counter, setCounter] = useState(30);
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref);

  useEffect(() => {
    if (isInView) {
      setInView(true);
    }
  }, [isInView]);

  useEffect(() => {
    if (seconds) {
      return; // If seconds is provided, don't animate the counter.
    }

    let interval: ReturnType<typeof setInterval> | undefined;

    if (inView) {
      setCounter(30);
      interval = setInterval(() => {
        setCounter((prev) => {
          if (prev < 44) {
            return prev + 1;
          } else {
            setIsFinished(true);
            clearInterval(interval);
            return prev;
          }
        });
      }, 1000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [inView, seconds]);

  return (
    <div
      ref={ref}
      className="flex items-center px-4 py-3 border-b border-[var(--guide-color)] border-solid border-x-0 border-t-0"
    >
      <div className="flex min-w-[35%] flex-col gap-0.5">
        <span className="text-label-14 font-semibold">{title}</span>
        <span className="text-label-14 text-gray-900">{subtitle}</span>
      </div>
      <div className="flex min-w-[35%] flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'size-2 flex-none rounded-full transition-colors',
              isFinished ? 'bg-geist-cyan' : 'bg-geist-warning'
            )}
          />
          <span className="text-label-14 font-medium text-gray-900 overflow-hidden">
            <AnimatePresence mode="wait">
              {isFinished ? (
                <motion.span
                  initial={{ opacity: 1 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  key="completed"
                >
                  Ready
                </motion.span>
              ) : (
                <motion.span
                  initial={{ opacity: 1 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  key="Building"
                >
                  Building
                </motion.span>
              )}
            </AnimatePresence>
          </span>
        </div>
        <span className="text-label-13-mono text-gray-900">
          <motion.span className="flex items-center gap-1" layout>
            <AnimatePresence>
              {isFinished ? null : (
                <motion.span
                  key="spinner"
                  initial={{ opacity: 1 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  layout
                >
                  <Spinner className="size-3" />
                </motion.span>
              )}
            </AnimatePresence>
            <motion.span key="counter" layout>
              {seconds || `${counter}s`}
            </motion.span>
          </motion.span>
        </span>
      </div>
    </div>
  );
}
