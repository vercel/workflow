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
    // Sort steps by createdAt to maintain chronological order
    const sortedSteps = steps.slice().sort((a, b) => {
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      return aTime - bTime;
    });

    // Group events by their correlation ID to associate with steps/hooks
    const eventsByStepId = new Map<string, Event[]>();
    const eventsByHookId = new Map<string, Event[]>();
    const runLevelEvents: Event[] = [];

    for (const event of events) {
      // Try to associate event with a step or hook via correlationId
      // For now, collect all events at run level
      // TODO: Better event association logic
      const correlationId = event.correlationId;
      if (correlationId) {
        // Check if correlation ID matches a step or hook
        const matchingStep = sortedSteps.find(
          (s) => s.stepId === correlationId
        );
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
    const stepSpans = sortedSteps.map((step, index) => {
      const parentSpanId =
        index === 0 ? run.runId : String(sortedSteps[index - 1].stepId);
      const stepEvents = eventsByStepId.get(step.stepId) || [];
      return stepToSpan(step, parentSpanId, stepEvents, now);
    });

    const hookSpans = hooks.map((hook) => {
      const hookEvents = eventsByHookId.get(hook.hookId) || [];
      return hookToSpan(hook, run.runId, hookEvents);
    });

    return {
      traceId: run.runId,
      rootSpanId: run.runId,
      spans: [runToSpan(run, runLevelEvents, now), ...stepSpans, ...hookSpans],
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
