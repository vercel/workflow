'use client';

import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ErrorBoundary } from './error-boundary';
import {
  EntityDetailPanel,
  type SelectedSpanInfo,
  type SpanSelectionInfo,
} from './sidebar/entity-detail-panel';
import {
  TraceViewerContextProvider,
  TraceViewerTimeline,
  useTraceViewer,
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
const DEFAULT_PANEL_WIDTH = 380;
const MIN_PANEL_WIDTH = 240;

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

// ---------------------------------------------------------------------------
// Bridge: reads selected span from trace viewer context and notifies parent
// ---------------------------------------------------------------------------

/**
 * Bridge component that lives INSIDE the TraceViewerContextProvider and
 * reads the selected span info, passing it up to the parent via callback.
 * This allows the parent to render the detail panel OUTSIDE the context.
 */
function SelectionBridge({
  onSelectionChange,
}: {
  onSelectionChange: (info: SelectedSpanInfo | null) => void;
}) {
  const { state } = useTraceViewer();
  const { selected } = state;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  useEffect(() => {
    if (selected) {
      onSelectionChangeRef.current({
        events: selected.events?.map((e) => e.event),
        data: selected.span.attributes?.data,
        resource: selected.span.attributes?.resource as string | undefined,
        spanId: selected.span.spanId,
      });
    } else {
      onSelectionChangeRef.current(null);
    }
  }, [selected]);

  return null;
}

/**
 * Bridge component to deselect from outside the context.
 */
function DeselectBridge({ triggerDeselect }: { triggerDeselect: number }) {
  const { dispatch } = useTraceViewer();

  useEffect(() => {
    if (triggerDeselect > 0) {
      dispatch({ type: 'deselect' });
    }
  }, [triggerDeselect, dispatch]);

  return null;
}

// ---------------------------------------------------------------------------
// Panel chrome (header with name/duration, close button)
// ---------------------------------------------------------------------------

function PanelResizeHandle({
  onResize,
}: {
  onResize: (deltaX: number) => void;
}) {
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      let lastX = e.clientX;
      const onPointerMove = (moveEvent: PointerEvent) => {
        const deltaX = lastX - moveEvent.clientX;
        lastX = moveEvent.clientX;
        onResize(deltaX);
      };
      const onPointerUp = () => {
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
      };
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    },
    [onResize]
  );

  return (
    <div
      className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400/50 z-10"
      onPointerDown={handlePointerDown}
    />
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

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
  const [selectedSpan, setSelectedSpan] = useState<SelectedSpanInfo | null>(
    null
  );
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [deselectTrigger, setDeselectTrigger] = useState(0);

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

  const handleSelectionChange = useCallback((info: SelectedSpanInfo | null) => {
    setSelectedSpan(info);
  }, []);

  const handleClose = useCallback(() => {
    setSelectedSpan(null);
    setDeselectTrigger((n) => n + 1);
  }, []);

  const handleResize = useCallback((deltaX: number) => {
    setPanelWidth((w) => Math.max(MIN_PANEL_WIDTH, w + deltaX));
  }, []);

  // Get the selected span name and duration for the panel header
  const selectedSpanName = useMemo(() => {
    if (!selectedSpan?.data) return undefined;
    const data = selectedSpan.data as Record<string, unknown>;
    return (
      (data.stepName as string) ??
      (data.workflowName as string) ??
      (data.hookId as string) ??
      'Details'
    );
  }, [selectedSpan?.data]);

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
    <div className="relative w-full h-full flex">
      {/* Timeline (takes remaining space) */}
      <div className="flex-1 min-w-0 relative">
        <TraceViewerContextProvider
          customSpanClassNameFunc={getCustomSpanClassName}
          customSpanEventClassNameFunc={getCustomSpanEventClassName}
        >
          <SelectionBridge onSelectionChange={handleSelectionChange} />
          <DeselectBridge triggerDeselect={deselectTrigger} />
          <TraceViewerTimeline height="100%" trace={trace} />
        </TraceViewerContextProvider>
      </div>

      {/* Detail panel (rendered outside the context, as a sibling) */}
      {selectedSpan && (
        <div
          className="relative border-l flex-shrink-0 flex flex-col"
          style={{
            width: panelWidth,
            borderColor: 'var(--ds-gray-200)',
            backgroundColor: 'var(--ds-background-100)',
          }}
        >
          <PanelResizeHandle onResize={handleResize} />
          {/* Panel header */}
          <div
            className="flex items-center justify-between px-3 py-2 border-b flex-shrink-0"
            style={{ borderColor: 'var(--ds-gray-200)' }}
          >
            <span
              className="text-sm font-medium truncate"
              style={{ color: 'var(--ds-gray-1000)' }}
            >
              {selectedSpanName}
            </span>
            <button
              type="button"
              aria-label="Close panel"
              onClick={handleClose}
              className="ml-2 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 flex-shrink-0"
            >
              <X size={16} />
            </button>
          </div>
          {/* Panel body */}
          <div className="flex-1 overflow-y-auto">
            <ErrorBoundary title="Failed to load entity details">
              <EntityDetailPanel
                run={run}
                onStreamClick={onStreamClick}
                spanDetailData={spanDetailData ?? null}
                spanDetailError={spanDetailError}
                spanDetailLoading={spanDetailLoading}
                onSpanSelect={handleSpanSelect}
                onWakeUpSleep={onWakeUpSleep}
                onResolveHook={onResolveHook}
                selectedSpan={selectedSpan}
              />
            </ErrorBoundary>
          </div>
        </div>
      )}
    </div>
  );
};
