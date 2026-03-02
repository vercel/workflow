'use client';

import { CheckIcon, Loader2Icon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { WorkflowLogs } from './workflow-logs';

type WorkflowLog = {
  duration: number;
  text: string;
};

const Loading = (
  <Loader2Icon
    key="loading"
    className="size-[13px] text-muted-foreground animate-spin"
  />
);
const Success = (
  <div key="success">
    <CheckIcon className="size-[14px] text-emerald-500" />
  </div>
);
const ErrorIndicator = (
  <div key="error">
    <XIcon className="size-[14px] text-rose-500" />
  </div>
);

type LineState = 'idle' | 'loading' | 'success' | 'error';

export const WorkflowExample = ({
  codeBlock,
  logs,
}: {
  codeBlock: React.ReactNode;
  logs: WorkflowLog[];
}) => {
  const [lineStates, setLineStates] = useState<LineState[]>([
    'idle',
    'idle',
    'idle',
  ]);
  const [isRetry, setIsRetry] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const animate = async () => {
      if (isRetry) {
        // On retry with workflow: only the failed step re-runs
        // Steps 1 and 2 are already successful, so skip directly to step 3
        // Wait 2s delay before starting
        await new Promise((resolve) => setTimeout(resolve, 2000));

        if (cancelled) return;

        setLineStates((prev) => {
          const next = [...prev];
          next[2] = 'loading';
          return next;
        });

        // Run for 4s (queue + run + success logs)
        await new Promise((resolve) => setTimeout(resolve, 4000));

        if (cancelled) return;

        setLineStates((prev) => {
          const next = [...prev];
          next[2] = 'success';
          return next;
        });
      } else {
        // Initial run: reset to idle
        setLineStates(['idle', 'idle', 'idle']);

        // Line 1 (getUser): 3 logs, 3 seconds total
        setLineStates((prev) => {
          const next = [...prev];
          next[0] = 'loading';
          return next;
        });

        await new Promise((resolve) => setTimeout(resolve, 3000));

        if (cancelled) return;

        setLineStates((prev) => {
          const next = [...prev];
          next[0] = 'success';
          return next;
        });

        // Line 2 (generateEmail): 2s delay + 3 logs
        await new Promise((resolve) => setTimeout(resolve, 2000));

        if (cancelled) return;

        setLineStates((prev) => {
          const next = [...prev];
          next[1] = 'loading';
          return next;
        });

        await new Promise((resolve) => setTimeout(resolve, 3000));

        if (cancelled) return;

        setLineStates((prev) => {
          const next = [...prev];
          next[1] = 'success';
          return next;
        });

        // Line 3 (sendEmail): 2s delay + 4 logs, ends in error
        await new Promise((resolve) => setTimeout(resolve, 2000));

        if (cancelled) return;

        setLineStates((prev) => {
          const next = [...prev];
          next[2] = 'loading';
          return next;
        });

        await new Promise((resolve) => setTimeout(resolve, 3000));

        if (cancelled) return;

        setLineStates((prev) => {
          const next = [...prev];
          next[2] = 'error';
          return next;
        });

        // Wait 1s after error, then trigger retry
        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (cancelled) return;

        setIsRetry(true);
      }
    };

    animate();

    return () => {
      cancelled = true;
    };
  }, [isRetry]);

  const renderIndicator = (state: LineState) => {
    if (state === 'loading') return Loading;
    if (state === 'success') return Success;
    if (state === 'error') return ErrorIndicator;
    return null;
  };

  return (
    <div className="relative isolate max-w-3xl mx-auto">
      <div className="bg-background border rounded-md overflow-x-auto pb-[52px]">
        <div className="relative">
          <div className="flex absolute z-10 flex-col left-[18px] top-[69px] pointer-events-none select-none">
            {renderIndicator(lineStates[0])}
            <div className="h-[5px]" />
            {renderIndicator(lineStates[1])}
            <div className="h-[46px]" />
            {renderIndicator(lineStates[2])}
          </div>
          {codeBlock}
        </div>
        <WorkflowLogs logs={logs} />
      </div>
    </div>
  );
};
