'use client';

import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

// Color presets for trace rows
const colors = {
  workflow: 'border-blue-400 bg-blue-100 text-blue-700',
  stream: 'border-green-400 bg-green-100 text-green-700',
  tool: 'border-amber-400 bg-amber-100 text-amber-700',
  approval: 'border-pink-400 bg-pink-100 text-pink-700',
  webhook: 'border-purple-400 bg-purple-100 text-purple-700',
};

type TraceRow = {
  label: string;
  className: string;
  layoutClassName: string;
  duration: number;
};

const defaultRows: TraceRow[] = [
  {
    label: 'chatWorkflow',
    className: colors.workflow,
    layoutClassName: 'ml-0 w-full',
    duration: 100,
  },
  {
    label: 'agent.stream',
    className: colors.stream,
    layoutClassName: 'ml-[2%] w-[16%]',
    duration: 16,
  },
  {
    label: 'searchWeb',
    className: colors.tool,
    layoutClassName: 'ml-[20%] w-[13%]',
    duration: 13,
  },
  {
    label: 'agent.stream',
    className: colors.stream,
    layoutClassName: 'ml-[37%] w-[16%]',
    duration: 16,
  },
  {
    label: 'waitForHumanApproval',
    className: colors.approval,
    layoutClassName: 'ml-[57%] w-[24%]',
    duration: 24,
  },
  {
    label: 'agent.stream',
    className: colors.stream,
    layoutClassName: 'ml-[84%] w-[16%]',
    duration: 16,
  },
];

const messageQueueRows: TraceRow[] = [
  {
    label: 'chatWorkflow',
    className: colors.workflow,
    layoutClassName: 'ml-0 w-full',
    duration: 100,
  },
  {
    label: 'agent.stream',
    className: colors.stream,
    layoutClassName: 'ml-[2%] w-[16%]',
    duration: 16,
  },
  {
    label: 'hook.enqueue()',
    className: colors.webhook,
    layoutClassName: 'ml-[12%] w-[24%]',
    duration: 24,
  },
  {
    label: 'tool.checkDB()',
    className: colors.tool,
    layoutClassName: 'ml-[18%] w-[18%]',
    duration: 18,
  },
  {
    label: 'agent.stream',
    className: colors.stream,
    layoutClassName: 'ml-[36%] w-[16%]',
    duration: 16,
  },
  {
    label: 'hook.enqueue()',
    className: colors.webhook,
    layoutClassName: 'ml-[46%] w-[24%]',
    duration: 24,
  },
  {
    label: 'tool.search()',
    className: colors.tool,
    layoutClassName: 'ml-[52%] w-[18%]',
    duration: 18,
  },
  {
    label: 'agent.stream',
    className: colors.stream,
    layoutClassName: 'ml-[70%] w-[16%]',
    duration: 16,
  },
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
            className={`flex flex-col overflow-hidden ${row.layoutClassName}`}
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
