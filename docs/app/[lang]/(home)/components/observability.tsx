'use client';

import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

const rows = [
  {
    label: 'workflow()',
    className: 'border-blue-400 bg-blue-100 text-blue-700',
    layoutClassName: 'ml-0 w-full',
    duration: 100,
  },
  {
    label: 'process()',
    className: 'border-green-400 bg-green-100 text-green-700',
    layoutClassName: 'ml-0 w-1/5',
    duration: 20,
  },
  {
    label: 'parse()',
    className: 'border-green-400 bg-green-100 text-green-700',
    layoutClassName: 'ml-[20%] w-1/4',
    duration: 25,
  },
  {
    label: 'transform()',
    className: 'border-green-400 bg-green-100 text-green-700',
    layoutClassName: 'ml-[45%] w-1/5',
    duration: 20,
  },
  {
    label: 'enrich()',
    className: 'border-green-400 bg-green-100 text-green-700',
    layoutClassName: 'ml-[65%] w-[15%]',
    duration: 15,
  },
  {
    label: 'validate()',
    className: 'border-green-400 bg-green-100 text-green-700',
    layoutClassName: 'ml-[80%] w-1/5',
    duration: 20,
  },
];

export const Observability = () => (
  <div className="grid grid-rows-[auto_1fr] gap-12 py-8 sm:py-12">
    <h2 className="font-medium text-xl tracking-tight sm:text-2xl text-muted-foreground">
      <span className="text-foreground">Observability</span>. Inspect every run
      end‑to‑end. Pause, replay, and time‑travel through steps with traces,
      logs, and metrics automatically.
    </h2>
    <div className="">
      <div className="space-y-2.5 w-full">
        {rows.map((row, index) => (
          <div
            key={row.label}
            className={`flex flex-col overflow-hidden ${row.layoutClassName}`}
          >
            <div className="relative h-6.5 w-full">
              <motion.div
                initial={{ width: 0, opacity: 0 }}
                whileInView={{ width: 'auto', opacity: 1 }}
                viewport={{ once: true, amount: 0.8 }}
                transition={{
                  duration: 0.55,
                  delay: index * 0.15,
                  ease: [0.22, 1, 0.36, 1],
                }}
                className={cn(
                  'h-full rounded-sm border overflow-hidden',
                  row.className
                )}
              >
                <div className="flex justify-between items-center px-2 pt-1 pb-[6px]">
                  <span className="text-[11px] font-mono font-medium text-foreground">
                    {row.label}
                  </span>
                  {index === 0 && (
                    <span className="text-[11px]">{row.duration}ms</span>
                  )}
                </div>
              </motion.div>
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);
