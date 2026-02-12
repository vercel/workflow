'use client';

import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ErrorBoundary } from './error-boundary';
import {
  EntityDetailPanel,
  type SpanSelectionInfo,
} from './sidebar/entity-detail-panel';
import {
  TraceViewerContextProvider,
  TraceViewerTimeline,
} from './trace-viewer';
import type { Span } from './trace-viewer/types';
import { Skeleton } from './ui/skeleton';
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

type GroupedEvents = {
  eventsByStepId: Map<string, Event[]>;
  eventsByHookId: Map<string, Event[]>;
  runLevelEvents: Event[];
  timerEvents: Map<string, Event[]>;
  hookEvents: Map<string, Event[]>;
};

const isTimerEvent = (eventType: string) =>
  eventType === 'wait_created' || eventType === 'wait_completed';

const isHookLifecycleEvent = (eventType: string) =>
  eventType === 'hook_received' ||
  eventType === 'hook_created' ||
  eventType === 'hook_disposed';

const pushEvent = (
  map: Map<string, Event[]>,
  correlationId: string,
  event: Event
) => {
  const existing = map.get(correlationId);
  if (existing) {
    existing.push(event);
    return;
  }
  map.set(correlationId, [event]);
};

const groupEventsByCorrelation = (
  events: Event[],
  steps: Step[],
  hooks: Hook[]
): GroupedEvents => {
  const eventsByStepId = new Map<string, Event[]>();
  const eventsByHookId = new Map<string, Event[]>();
  const runLevelEvents: Event[] = [];
  const timerEvents = new Map<string, Event[]>();
  const hookEvents = new Map<string, Event[]>();
  const stepIds = new Set(steps.map((step) => step.stepId));
  const hookIds = new Set(hooks.map((hook) => hook.hookId));

  for (const event of events) {
    const correlationId = event.correlationId;
    if (!correlationId) {
      runLevelEvents.push(event);
      continue;
    }

    if (isTimerEvent(event.eventType)) {
      pushEvent(timerEvents, correlationId, event);
      continue;
    }

    if (isHookLifecycleEvent(event.eventType)) {
      pushEvent(hookEvents, correlationId, event);
      continue;
    }

    if (stepIds.has(correlationId)) {
      pushEvent(eventsByStepId, correlationId, event);
      continue;
    }

    if (hookIds.has(correlationId)) {
      pushEvent(eventsByHookId, correlationId, event);
      continue;
    }

    runLevelEvents.push(event);
  }

  return {
    eventsByStepId,
    eventsByHookId,
    runLevelEvents,
    timerEvents,
    hookEvents,
  };
};

const buildSpans = (
  run: WorkflowRun,
  steps: Step[],
  groupedEvents: GroupedEvents,
  now: Date
) => {
  const stepSpans = steps.map((step) => {
    const stepEvents = groupedEvents.eventsByStepId.get(step.stepId) || [];
    return stepToSpan(step, stepEvents, now);
  });

  const hookSpans = Array.from(groupedEvents.hookEvents.values())
    .map((events) => hookToSpan(events, run, now))
    .filter((span): span is Span => span !== null);

  const waitSpans = Array.from(groupedEvents.timerEvents.values())
    .map((events) => waitToSpan(events, run, now))
    .filter((span): span is Span => span !== null);

  return {
    runSpan: runToSpan(run, groupedEvents.runLevelEvents, now),
    spans: [...stepSpans, ...hookSpans, ...waitSpans],
  };
};

const cascadeSpans = (runSpan: Span, spans: Span[]) => {
  const sortedSpans = [
    runSpan,
    ...spans.slice().sort((a, b) => {
      const aStart = otelTimeToMs(a.startTime);
      const bStart = otelTimeToMs(b.startTime);
      return aStart - bStart;
    }),
  ];

  return sortedSpans.map((span, index) => {
    const parentSpanId =
      index === 0 ? undefined : String(sortedSpans[index - 1].spanId);
    return {
      ...span,
      parentSpanId,
    };
  });
};

const buildTrace = (
  run: WorkflowRun,
  steps: Step[],
  hooks: Hook[],
  events: Event[],
  now: Date
) => {
  const groupedEvents = groupEventsByCorrelation(events, steps, hooks);
  const { runSpan, spans } = buildSpans(run, steps, groupedEvents, now);
  const sortedCascadingSpans = cascadeSpans(runSpan, spans);

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
};

/** Re-export SpanSelectionInfo for consumers */
export type { SpanSelectionInfo };

export const WorkflowTraceViewer = ({
  run,
  steps,
  hooks,
  events,
  isLoading,
  error,
  spanDetailData,
  spanDetailLoading,
  spanDetailError,
  onWakeUpSleep,
  onResolveHook,
  onStreamClick,
  onSpanSelect,
}: {
  run: WorkflowRun;
  steps: Step[];
  hooks: Hook[];
  events: Event[];
  isLoading?: boolean;
  error?: Error | null;
  spanDetailData?: WorkflowRun | Step | Hook | Event | null;
  spanDetailLoading?: boolean;
  spanDetailError?: Error | null;
  onWakeUpSleep?: (
    runId: string,
    correlationId: string
  ) => Promise<{ stoppedCount: number }>;
  onResolveHook?: (
    hookToken: string,
    payload: unknown,
    hook?: Hook
  ) => Promise<void>;
  /** Callback when a stream reference is clicked in the detail panel */
  onStreamClick?: (streamId: string) => void;
  /** Callback when a span is selected. */
  onSpanSelect?: (info: SpanSelectionInfo) => void;
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
    return buildTrace(run, steps, hooks, events, now);
  }, [run, steps, hooks, events, now]);

  useEffect(() => {
    if (error && !isLoading) {
      console.error(error);
      toast.error('Error loading workflow trace data', {
        description: error.message,
      });
    }
  }, [error, isLoading]);

  const handleSpanSelect = useCallback(
    (info: SpanSelectionInfo) => {
      onSpanSelect?.(info);
    },
    [onSpanSelect]
  );

  const detailPanel = (
    <EntityDetailPanel
      run={run}
      onStreamClick={onStreamClick}
      spanDetailData={spanDetailData ?? null}
      spanDetailError={spanDetailError}
      spanDetailLoading={spanDetailLoading}
      onSpanSelect={handleSpanSelect}
      onWakeUpSleep={onWakeUpSleep}
      onResolveHook={onResolveHook}
    />
  );

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
          <ErrorBoundary title="Failed to load entity details">
            {detailPanel}
          </ErrorBoundary>
        }
      >
        <TraceViewerTimeline height="100%" trace={trace} withPanel />
      </TraceViewerContextProvider>
    </div>
  );
};
