'use client';

import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

// Color presets for trace rows
const colors = {
  workflow:
    'bg-[#E1F0FF] dark:bg-[#00254D] border-[#99CEFF] text-[#0070F3] dark:border-[#0067D6] dark:text-[#52AEFF]',
  stream:
    'bg-[#DCF6DC] dark:bg-[#1B311E] border-[#99E59F] text-[#46A758] dark:border-[#297C3B] dark:text-[#6CDA76]',
  tool: 'bg-[#FFF4E5] dark:bg-[#3D2800] border-[#FFCC80] text-[#F5A623] dark:border-[#9A6700] dark:text-[#FFCA28]',
  approval:
    'bg-[#FCE7F3] dark:bg-[#4A1D34] border-[#F9A8D4] text-[#EC4899] dark:border-[#BE185D] dark:text-[#F472B6]',
  webhook:
    'bg-[#EDE9FE] dark:bg-[#2E1065] border-[#C4B5FD] text-[#7C3AED] dark:border-[#6D28D9] dark:text-[#A78BFA]',
};

type TraceRow = {
  label: string;
  className: string;
  start: number;
  duration: number;
};

const defaultRows: TraceRow[] = [
  {
    label: 'chatWorkflow',
    className: colors.workflow,
    start: 0,
    duration: 100,
  },
  { label: 'agent.stream', className: colors.stream, start: 2, duration: 16 },
  { label: 'searchWeb', className: colors.tool, start: 20, duration: 13 },
  { label: 'agent.stream', className: colors.stream, start: 37, duration: 16 },
  {
    label: 'waitForHumanApproval',
    className: colors.approval,
    start: 57,
    duration: 24,
  },
  { label: 'agent.stream', className: colors.stream, start: 84, duration: 16 },
];

const messageQueueRows: TraceRow[] = [
  {
    label: 'chatWorkflow',
    className: colors.workflow,
    start: 0,
    duration: 100,
  },
  { label: 'agent.stream', className: colors.stream, start: 2, duration: 16 },
  {
    label: 'hook.enqueue()',
    className: colors.webhook,
    start: 12,
    duration: 24,
  },
  {
    label: 'tool.checkDB()',
    className: colors.tool,
    start: 18,
    duration: 18,
  },
  { label: 'agent.stream', className: colors.stream, start: 36, duration: 16 },
  {
    label: 'hook.enqueue()',
    className: colors.webhook,
    start: 46,
    duration: 24,
  },
  {
    label: 'tool.search()',
    className: colors.tool,
    start: 52,
    duration: 18,
  },
  { label: 'agent.stream', className: colors.stream, start: 70, duration: 16 },
];

const variants = {
  default: defaultRows,
  'message-queue': messageQueueRows,
} as const;

type Variant = keyof typeof variants;

interface AgentTracesProps {
  variant?: Variant;
}

export const AgentTraces = ({ variant = 'default' }: AgentTracesProps) => {
  const rows = variants[variant];

  return (
    <div className="not-prose my-8 rounded-lg border bg-card p-4 sm:p-6">
      <div className="space-y-2 w-full">
        {rows.map((row, index) => (
          <div
            key={`${row.label}-${index}`}
            className="flex flex-col overflow-hidden"
            style={{
              marginLeft: `${row.start}%`,
              width: `${row.duration}%`,
            }}
          >
            <div className="relative h-6 w-full">
              <motion.div
                initial={{ width: 0, opacity: 0 }}
                whileInView={{ width: 'auto', opacity: 1 }}
                viewport={{ once: true, amount: 0.8 }}
                transition={{
                  duration: 0.55,
                  delay: index * 0.12,
                  ease: [0.22, 1, 0.36, 1],
                }}
                className={cn(
                  'h-full rounded-sm border overflow-hidden',
                  row.className
                )}
              >
                <div className="flex justify-between items-center h-full px-2">
                  <span className="text-[10px] sm:text-[11px] font-mono font-medium text-foreground truncate leading-none">
                    {row.label}
                  </span>
                  {index === 0 && (
                    <span className="text-[10px] sm:text-[11px] hidden sm:inline leading-none">
                      {row.duration}ms
                    </span>
                  )}
                </div>
              </motion.div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
