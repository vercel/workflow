import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { EnvMap } from './api/workflow-server-actions';
import { Skeleton } from './components/ui/skeleton';
import { WorkflowDetailPanel } from './sidebar/workflow-detail-panel';
import {
  TraceViewerContextProvider,
  TraceViewerTimeline,
} from './trace-viewer';
import {
  getCustomSpanClassName,
  getCustomSpanEventClassName,
} from './workflow-traces/trace-colors';
import {
  hookToSpan,
  runToSpan,
  stepToSpan,
  WORKFLOW_LIBRARY,
  waitToSpan,
} from './workflow-traces/trace-span-construction';
import { otelTimeToMs } from './workflow-traces/trace-time-utils';

const RE_RENDER_INTERVAL_MS = 2000;

export const WorkflowTraceViewer = ({
  run,
  steps,
  hooks,
  events,
  env,
  isLoading,
  error,
  onStreamClick,
}: {
  run: WorkflowRun;
  steps: Step[];
  hooks: Hook[];
  events: Event[];
  env: EnvMap;
  isLoading?: boolean;
  error?: Error | null;
  /** Callback when a stream reference is clicked in the detail panel */
  onStreamClick?: (streamId: string) => void;
}) => {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!run?.completedAt) {
      const interval = setInterval(() => {
        setNow(new Date());
      }, RE_RENDER_INTERVAL_MS);
      return () => clearInterval(interval);
    }
    return undefined;
  }, [run?.completedAt]);

  const trace = useMemo(() => {
    if (!run) {
      return undefined;
    }
    // Group events by their correlation ID to associate with steps/hooks
    const eventsByStepId = new Map<string, Event[]>();
    const eventsByHookId = new Map<string, Event[]>();
    const runLevelEvents: Event[] = [];
    const timerEvents = new Map<string, Event[]>();
    const hookEvents = new Map<string, Event[]>();

    for (const event of events) {
      if (
        event.eventType === 'wait_created' ||
        event.eventType === 'wait_completed'
      ) {
        const existing = timerEvents.get(event.correlationId) || [];
        existing.push(event);
        timerEvents.set(event.correlationId, existing);
        continue;
      }

      if (
        event.eventType === 'hook_received' ||
        event.eventType === 'hook_created' ||
        event.eventType === 'hook_disposed'
      ) {
        const existing = hookEvents.get(event.correlationId) || [];
        existing.push(event);
        hookEvents.set(event.correlationId, existing);
        continue;
      }
      // Try to associate event with a step or hook via correlationId
      // For now, all other events are collected at run level
      const correlationId = event.correlationId;
      if (correlationId) {
        // Check if correlation ID matches a step or hook
        const matchingStep = steps.find((s) => s.stepId === correlationId);
        const matchingHook = hooks.find((h) => h.hookId === correlationId);

        if (matchingStep) {
          const existing = eventsByStepId.get(correlationId) || [];
          existing.push(event);
          eventsByStepId.set(correlationId, existing);
        } else if (matchingHook) {
          const existing = eventsByHookId.get(correlationId) || [];
          existing.push(event);
          eventsByHookId.set(correlationId, existing);
        } else {
          runLevelEvents.push(event);
        }
      } else {
        runLevelEvents.push(event);
      }
    }

    // Chain steps together so each one appears on its own row
    // First step is child of root, each subsequent step is child of previous
    const stepSpans = steps.map((step) => {
      const stepEvents = eventsByStepId.get(step.stepId) || [];
      return stepToSpan(step, stepEvents, now);
    });

    const hookSpans = Array.from(hookEvents.entries())
      .map(([_, events]) => {
        return hookToSpan(events, run, now);
      })
      .filter((span) => span !== null);

    const waitSpans = Array.from(timerEvents.entries())
      .map(([_, events]) => {
        return waitToSpan(events, run, now);
      })
      .filter((span) => span !== null);

    const runSpan = runToSpan(run, runLevelEvents, now);
    const spans = [...stepSpans, ...hookSpans, ...waitSpans];
    const sortedSpans = [
      runSpan,
      ...spans.slice().sort((a, b) => {
        const aStart = otelTimeToMs(a.startTime);
        const bStart = otelTimeToMs(b.startTime);
        return aStart - bStart;
      }),
    ];

    const sortedCascadingSpans = sortedSpans.map((span, index) => {
      const parentSpanId =
        index === 0 ? undefined : String(sortedSpans[index - 1].spanId);
      return {
        ...span,
        parentSpanId,
      };
    });

    return {
      traceId: run.runId,
      rootSpanId: run.runId,
      spans: sortedCascadingSpans,
      resources: [
        {
          name: 'workflow',
          attributes: {
            'service.name': WORKFLOW_LIBRARY.name,
          },
        },
      ],
    };
  }, [run, steps, hooks, events, now]);

  useEffect(() => {
    if (error && !isLoading) {
      console.error(error);
      toast.error('Error loading workflow trace data', {
        description: error.message,
      });
    }
  }, [error, isLoading]);

  if (isLoading || !trace) {
    return (
      <div className="relative w-full h-full">
        <div className="border-b border-gray-alpha-400 w-full" />
        <Skeleton className="w-full ml-2 mt-1 mb-1 h-[56px]" />
        <div className="p-2 relative w-full">
          <Skeleton className="w-full mt-6 h-[20px]" />
          <Skeleton className="w-[10%] mt-2 ml-6 h-[20px]" />
          <Skeleton className="w-[10%] mt-2 ml-12 h-[20px]" />
          <Skeleton className="w-[20%] mt-2 ml-16 h-[20px]" />
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      <TraceViewerContextProvider
        withPanel
        customSpanClassNameFunc={getCustomSpanClassName}
        customSpanEventClassNameFunc={getCustomSpanEventClassName}
        customPanelComponent={
          <WorkflowDetailPanel
            env={env}
            run={run}
            onStreamClick={onStreamClick}
          />
        }
      >
        <TraceViewerTimeline height="100%" trace={trace} withPanel />
      </TraceViewerContextProvider>
    </div>
  );
};
