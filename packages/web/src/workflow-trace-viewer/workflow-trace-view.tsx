import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { useEffect, useMemo, useState } from 'react';
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
} from './workflow-traces/trace-span-construction';

const RE_RENDER_INTERVAL_MS = 2000;

export const WorkflowTraceViewer = ({
  run,
  steps,
  hooks,
  events,
  env,
  isLoading,
}: {
  run: WorkflowRun;
  steps: Step[];
  hooks: Hook[];
  events: Event[];
  env: EnvMap;
  isLoading?: boolean;
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
    // Group events by their correlation ID to associate with steps/hooks
    const eventsByStepId = new Map<string, Event[]>();
    const eventsByHookId = new Map<string, Event[]>();
    const runLevelEvents: Event[] = [];

    for (const event of events) {
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

    const runSpan = runToSpan(run, runLevelEvents, now);
    const spans = [runSpan, ...stepSpans, ...hookSpans];
    const sortedSpans = spans.slice().sort((a, b) => {
      const aTime = new Date(a.startTime[0]).getTime();
      const bTime = new Date(b.startTime[0]).getTime();
      return aTime - bTime;
    });

    const sortedCascadingSpans = sortedSpans.map((span, index) => {
      const parentSpanId =
        index === 0 ? undefined : String(sortedSpans[index - 1].spanId);
      return {
        ...span,
        parentSpanId,
      };
    });

    console.log(sortedCascadingSpans);

    return {
      traceId: run.runId,
      rootSpanId: run.runId,
      spans: sortedCascadingSpans,
      resources: [
        {
          name: 'workflow',
          attributes: {
            'service.name': 'vercel-workflow',
          },
        },
      ],
    };
  }, [run, steps, hooks, events, now]);

  return (
    <TraceViewerContextProvider
      withPanel
      customSpanClassNameFunc={getCustomSpanClassName}
      customSpanEventClassNameFunc={getCustomSpanEventClassName}
      customPanelComponent={<WorkflowDetailPanel env={env} />}
    >
      <TraceViewerTimeline
        height={800}
        trace={!isLoading ? trace : undefined}
        withPanel
      />
    </TraceViewerContextProvider>
  );
};
