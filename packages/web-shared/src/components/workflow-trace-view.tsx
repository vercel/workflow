'use client';

import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { Clock, Copy, Info, Send, Type, XCircle } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { ErrorBoundary } from './error-boundary';
import {
  EntityDetailPanel,
  type SpanSelectionInfo,
} from './sidebar/entity-detail-panel';
import { ResolveHookModal } from './sidebar/resolve-hook-modal';
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

// Stable no-op function to avoid re-creating closures
const noop = (): void => {};

/**
 * While a run is live, continuously grow root.duration and rescale so the
 * trace always fits within the viewport. Individual span widths are grown
 * by each SpanComponent's own useEffect (see node.tsx).
 */
function useLiveTick(isLive: boolean): void {
  const { state, dispatch } = useTraceViewer();
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!isLive) return;

    // Grow root.duration on every frame so span rAFs see the latest time
    let rafId = 0;
    const tick = (): void => {
      const { root } = stateRef.current;
      if (root.startTime) {
        const nowMs = Date.now();
        if (nowMs > root.endTime) {
          root.endTime = nowMs;
          root.duration = root.endTime - root.startTime;
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    // Re-scale smoothly so the trace fits the viewport as it grows.
    // We dispatch detectBaseScale only when the computed baseScale has
    // changed enough to matter visually (>0.1% shift), avoiding
    // unnecessary React re-renders while keeping things smooth.
    let scaleRafId = 0;
    let lastBaseScale = 0;
    const scaleTick = (): void => {
      const s = stateRef.current;
      if (s.root.duration > 0) {
        const newBaseScale = (s.width - s.scrollbarWidth) / s.root.duration;
        const delta = Math.abs(newBaseScale - lastBaseScale);
        if (delta > lastBaseScale * 0.001 || lastBaseScale === 0) {
          lastBaseScale = newBaseScale;
          dispatch({ type: 'detectBaseScale' });
        }
      }
      scaleRafId = requestAnimationFrame(scaleTick);
    };
    scaleRafId = requestAnimationFrame(scaleTick);

    return () => {
      cancelAnimationFrame(rafId);
      cancelAnimationFrame(scaleRafId);
    };
  }, [isLive, dispatch]);
}

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

// ──────────────────────────────────────────────────────────────────────────
// Right-click context menu for spans
// ──────────────────────────────────────────────────────────────────────────

type ResourceType = 'sleep' | 'step' | 'hook' | 'run' | 'unknown';

interface ContextMenuState {
  x: number;
  y: number;
  spanId: string;
  spanName: string;
  resourceType: ResourceType;
  /** Whether the span represents an active/pending resource (not yet completed) */
  isActive: boolean;
}

interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  action: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

function SpanContextMenu({
  menu,
  items,
  onClose,
}: {
  menu: ContextMenuState;
  items: ContextMenuItem[];
  onClose: () => void;
}): ReactNode {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    const handleScroll = (): void => {
      onClose();
    };
    // Use a timeout so we don't close immediately from the same event
    const timeout = setTimeout(() => {
      window.addEventListener('mousedown', handleClick);
      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('scroll', handleScroll, true);
    }, 0);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [onClose]);

  // Adjust position if menu would overflow viewport
  const [adjustedPos, setAdjustedPos] = useState({ x: menu.x, y: menu.y });
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let { x, y } = menu;
    if (rect.right > window.innerWidth) {
      x = window.innerWidth - rect.width - 8;
    }
    if (rect.bottom > window.innerHeight) {
      y = window.innerHeight - rect.height - 8;
    }
    if (x !== menu.x || y !== menu.y) {
      setAdjustedPos({ x, y });
    }
  }, [menu]);

  if (items.length === 0) return null;

  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: adjustedPos.x,
        top: adjustedPos.y,
        zIndex: 99999,
      }}
      className="min-w-[180px] rounded-lg border border-[var(--ds-gray-alpha-400)] bg-[var(--ds-background-100)] shadow-lg py-1 text-sm"
    >
      <div className="px-3 py-1.5 text-xs text-[var(--ds-gray-900)] font-medium truncate max-w-[240px] border-b border-[var(--ds-gray-alpha-200)] mb-1">
        {menu.spanName}
      </div>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={`w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-[var(--ds-gray-alpha-100)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            item.destructive
              ? 'text-[var(--ds-red-900)]'
              : 'text-[var(--ds-gray-1000)]'
          }`}
          disabled={item.disabled}
          onClick={() => {
            item.action();
            onClose();
          }}
        >
          {item.icon ?? null}
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  );
}

/** Inner wrapper that has access to the TraceViewer context */
function TraceViewerWithContextMenu({
  trace,
  run,
  hooks,
  isLive,
  onWakeUpSleep,
  onCancelRun,
  onResolveHook,
  children,
}: {
  trace: { spans: Span[] };
  run: WorkflowRun;
  hooks: Hook[];
  isLive: boolean;
  onWakeUpSleep?: (
    runId: string,
    correlationId: string
  ) => Promise<{ stoppedCount: number }>;
  onCancelRun?: (runId: string) => Promise<void>;
  onResolveHook?: (
    hookToken: string,
    payload: unknown,
    hook?: Hook
  ) => Promise<void>;
  children: ReactNode;
}): ReactNode {
  const { dispatch } = useTraceViewer();

  // Drive active span widths at 60fps without React re-renders
  useLiveTick(isLive);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [resolveHookTarget, setResolveHookTarget] = useState<Hook | null>(null);
  const [resolvingHook, setResolvingHook] = useState(false);
  // Track hooks resolved in this session so the context menu item hides immediately
  const [resolvedHookIds, setResolvedHookIds] = useState<Set<string>>(
    new Set()
  );

  // Build a lookup map: spanId → span
  const spanLookup = useMemo(() => {
    const map = new Map<string, Span>();
    for (const span of trace.spans) {
      map.set(span.spanId, span);
    }
    return map;
  }, [trace.spans]);

  // Build a lookup map: hookId → Hook
  const hookLookup = useMemo(() => {
    const map = new Map<string, Hook>();
    for (const hook of hooks) {
      map.set(hook.hookId, hook);
    }
    return map;
  }, [hooks]);

  const handleResolveHook = useCallback(
    async (payload: unknown) => {
      if (resolvingHook || !resolveHookTarget || !onResolveHook) return;
      if (!resolveHookTarget.token) {
        toast.error('Unable to resolve hook', {
          description:
            'Missing hook token. Try refreshing the run data and retry.',
        });
        return;
      }
      try {
        setResolvingHook(true);
        await onResolveHook(
          resolveHookTarget.token,
          payload,
          resolveHookTarget
        );
        toast.success('Hook resolved', {
          description: 'The payload has been sent and the hook resolved.',
        });
        // Mark this hook as resolved locally so the menu item hides immediately
        setResolvedHookIds((prev) =>
          new Set(prev).add(resolveHookTarget.hookId)
        );
        setResolveHookTarget(null);
      } catch (err) {
        console.error('Failed to resolve hook:', err);
        toast.error('Failed to resolve hook', {
          description:
            err instanceof Error ? err.message : 'An unknown error occurred',
        });
      } finally {
        setResolvingHook(false);
      }
    },
    [onResolveHook, resolveHookTarget, resolvingHook]
  );

  const handleContextMenu = useCallback(
    (e: ReactMouseEvent): void => {
      const target = e.target as HTMLElement;
      const $button = target.closest<HTMLButtonElement>('[data-span-id]');
      if (!$button) return;

      const spanId = $button.dataset.spanId;
      if (!spanId) return;

      e.preventDefault();
      e.stopPropagation();

      const span = spanLookup.get(spanId);
      if (!span) return;

      const resourceType =
        (span.attributes.resource as ResourceType) ?? 'unknown';
      const data = span.attributes.data as Record<string, unknown> | undefined;
      const isActive = !data?.completedAt && !data?.disposedAt;

      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        spanId,
        spanName: span.name,
        resourceType,
        isActive,
      });
    },
    [spanLookup]
  );

  const closeMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const getMenuItems = useCallback(
    (menu: ContextMenuState): ContextMenuItem[] => {
      const items: ContextMenuItem[] = [];

      // Sleep-specific: Wake Up (only on active runs)
      const isRunActive = !run.completedAt;
      if (
        menu.resourceType === 'sleep' &&
        menu.isActive &&
        isRunActive &&
        onWakeUpSleep
      ) {
        items.push({
          label: 'Wake Up Sleep',
          icon: <Clock className="h-3.5 w-3.5" />,
          action: () => {
            onWakeUpSleep(run.runId, menu.spanId)
              .then((result) => {
                if (result.stoppedCount > 0) {
                  toast.success('Sleep woken up', {
                    description: `Woke up ${String(result.stoppedCount)} sleep${result.stoppedCount > 1 ? 's' : ''}`,
                  });
                } else {
                  toast.info('No active sleeps found', {
                    description: 'The sleep may have already completed.',
                  });
                }
              })
              .catch((err: unknown) => {
                toast.error('Failed to wake up sleep', {
                  description:
                    err instanceof Error
                      ? err.message
                      : 'An unknown error occurred',
                });
              });
          },
        });
      }

      // Hook-specific: Resolve Hook (only on active, unresolved hooks)
      if (menu.resourceType === 'hook' && isRunActive && onResolveHook) {
        const hook = hookLookup.get(menu.spanId);
        const span = spanLookup.get(menu.spanId);
        // Check data-level disposedAt, span events, AND local resolved state
        const hookData = span?.attributes?.data as
          | { disposedAt?: unknown }
          | undefined;
        const isDisposed =
          Boolean(hookData?.disposedAt) ||
          Boolean(span?.events?.some((e) => e.name === 'hook_disposed')) ||
          resolvedHookIds.has(menu.spanId);
        if (hook?.token && !isDisposed) {
          items.push({
            label: 'Resolve Hook',
            icon: <Send className="h-3.5 w-3.5" />,
            action: () => {
              setResolveHookTarget(hook);
            },
          });
        }
      }

      // Run-specific: Cancel (only on active runs)
      if (menu.resourceType === 'run' && isRunActive && onCancelRun) {
        items.push({
          label: 'Cancel Run',
          icon: <XCircle className="h-3.5 w-3.5" />,
          destructive: true,
          action: () => {
            onCancelRun(run.runId).catch((err: unknown) => {
              toast.error('Failed to cancel run', {
                description:
                  err instanceof Error
                    ? err.message
                    : 'An unknown error occurred',
              });
            });
          },
        });
      }

      // Common actions
      items.push({
        label: 'View Details',
        icon: <Info className="h-3.5 w-3.5" />,
        action: () => {
          dispatch({ type: 'select', id: menu.spanId });
        },
      });

      items.push({
        label: 'Copy Name',
        icon: <Type className="h-3.5 w-3.5" />,
        action: () => {
          navigator.clipboard
            .writeText(menu.spanName)
            .then(() => {
              toast.success('Name copied to clipboard');
            })
            .catch(() => {
              toast.error('Failed to copy name');
            });
        },
      });

      items.push({
        label: 'Copy ID',
        icon: <Copy className="h-3.5 w-3.5" />,
        action: () => {
          navigator.clipboard
            .writeText(menu.spanId)
            .then(() => {
              toast.success('ID copied to clipboard');
            })
            .catch(() => {
              toast.error('Failed to copy ID');
            });
        },
      });

      return items;
    },
    [
      dispatch,
      onWakeUpSleep,
      onCancelRun,
      onResolveHook,
      hookLookup,
      resolvedHookIds,
      run.runId,
      run.completedAt,
    ]
  );

  return (
    <div className="relative w-full h-full" onContextMenu={handleContextMenu}>
      {children}
      {contextMenu ? (
        <SpanContextMenu
          menu={contextMenu}
          items={getMenuItems(contextMenu)}
          onClose={closeMenu}
        />
      ) : null}
      <ResolveHookModal
        isOpen={resolveHookTarget !== null}
        onClose={() => setResolveHookTarget(null)}
        onSubmit={handleResolveHook}
        isSubmitting={resolvingHook}
      />
    </div>
  );
}

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
  onCancelRun,
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
  /** Callback to cancel the current run */
  onCancelRun?: (runId: string) => Promise<void>;
  /** Callback when a stream reference is clicked in the detail panel */
  onStreamClick?: (streamId: string) => void;
  /** Callback when a span is selected. */
  onSpanSelect?: (info: SpanSelectionInfo) => void;
}) => {
  // Build trace only when actual data changes — no timer-driven rebuilds.
  // Active span widths are animated imperatively by useLiveTick at 60fps.
  const trace = useMemo(() => {
    if (!run) {
      return undefined;
    }
    return buildTrace(run, steps, hooks, events, new Date());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `new Date()` is intentionally not a dep; useLiveTick handles live growth
  }, [run, steps, hooks, events]);

  const isLive = Boolean(run && !run.completedAt);

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
          <ErrorBoundary title="Failed to load entity details">
            <EntityDetailPanel
              run={run}
              hooks={hooks}
              onStreamClick={onStreamClick}
              spanDetailData={spanDetailData ?? null}
              spanDetailError={spanDetailError}
              spanDetailLoading={spanDetailLoading}
              onSpanSelect={onSpanSelect ?? noop}
              onWakeUpSleep={onWakeUpSleep}
              onResolveHook={onResolveHook}
            />
          </ErrorBoundary>
        }
      >
        <TraceViewerWithContextMenu
          trace={trace}
          run={run}
          hooks={hooks}
          isLive={isLive}
          onWakeUpSleep={onWakeUpSleep}
          onCancelRun={onCancelRun}
          onResolveHook={onResolveHook}
        >
          <TraceViewerTimeline
            eagerRender
            height="100%"
            isLive={isLive}
            trace={trace}
            withPanel
          />
        </TraceViewerWithContextMenu>
      </TraceViewerContextProvider>
    </div>
  );
};
