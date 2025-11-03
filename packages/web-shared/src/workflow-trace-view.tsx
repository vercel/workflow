import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { EnvMap } from './api/workflow-server-actions';
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
}: {
  run: WorkflowRun;
  steps: Step[];
  hooks: Hook[];
  events: Event[];
  env: EnvMap;
  isLoading?: boolean;
  error?: Error | null;
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

    const hookSpans = hooks.map((hook) => {
      const hookEvents = eventsByHookId.get(hook.hookId) || [];
      return hookToSpan(hook, hookEvents);
    });

    const waitSpans = Array.from(timerEvents.entries()).map(
      ([correlationId, events]) => {
        return waitToSpan(correlationId, events, now);
      }
    );

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

  return (
    <div className="relative">
      {isLoading && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Loading trace data...
            </p>
          </div>
        </div>
      )}
      <TraceViewerContextProvider
        withPanel
        customSpanClassNameFunc={getCustomSpanClassName}
        customSpanEventClassNameFunc={getCustomSpanEventClassName}
        customPanelComponent={<WorkflowDetailPanel env={env} />}
      >
        <TraceViewerTimeline height={800} trace={trace} withPanel />
      </TraceViewerContextProvider>
    </div>
  );
};
