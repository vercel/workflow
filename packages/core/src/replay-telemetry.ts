import type { StepHydrationCache } from './step-hydration-cache.js';
import type { StepHydrationPhaseTimings } from './serialization.js';

/**
 * Aggregate diagnostics for one deterministic workflow replay.
 *
 * These counters intentionally avoid one span per event or completed step.
 * A long sequential workflow can replay thousands of historical steps, so
 * per-item spans would both distort the measurement and overwhelm the trace.
 */
export interface WorkflowReplayMetrics {
  eventsConsumed: number;
  eventCallbackInvocations: number;
  /** Synchronous CPU time spent offering events to registered callbacks. */
  eventConsumeMs: number;
  subscriptionWaitCount: number;
  /**
   * Wall time from finding an event with no subscriber to the next subscribe.
   * This includes and therefore overlaps hydration and VM promise continuation.
   */
  subscriptionWaitMs: number;
  completedSteps: number;
  /** Full ordered promise-queue slot time; includes stepHydrationMs. */
  stepDeliveryMs: number;
  /** Awaited cache lookup or deserialize/decrypt time for completed results. */
  stepHydrationMs: number;
  stepHydrationPhases: StepHydrationPhaseTimings;
  stepHydrationCacheHits: number;
  stepHydrationCacheMisses: number;
  stepHydrationCacheUnavailable: number;
  stepHydrationNonMemoizable: number;
}

interface StepReplayMeasurement {
  metrics: WorkflowReplayMetrics;
  deliveryStartedAt: number;
  hydrationStartedAt: number;
  cacheAvailable: boolean;
  cacheHit: boolean;
}

export function startStepReplayMeasurement(
  metrics: WorkflowReplayMetrics,
  cache: StepHydrationCache | undefined,
  eventId: string | undefined
): StepReplayMeasurement {
  metrics.completedSteps++;
  const cacheAvailable = cache !== undefined && eventId !== undefined;
  return {
    metrics,
    deliveryStartedAt: performance.now(),
    hydrationStartedAt: performance.now(),
    cacheAvailable,
    cacheHit: cacheAvailable && cache.has(eventId),
  };
}

export function finishStepHydrationMeasurement(
  measurement: StepReplayMeasurement,
  cache: StepHydrationCache | undefined,
  eventId: string | undefined
): void {
  const { metrics } = measurement;
  metrics.stepHydrationMs += performance.now() - measurement.hydrationStartedAt;
  if (!measurement.cacheAvailable) {
    metrics.stepHydrationCacheUnavailable++;
  } else if (measurement.cacheHit) {
    metrics.stepHydrationCacheHits++;
  } else {
    metrics.stepHydrationCacheMisses++;
    if (eventId === undefined || !cache?.has(eventId)) {
      metrics.stepHydrationNonMemoizable++;
    }
  }
}

export function failStepHydrationMeasurement(
  measurement: StepReplayMeasurement
): void {
  measurement.metrics.stepHydrationMs +=
    performance.now() - measurement.hydrationStartedAt;
}

export function finishStepDeliveryMeasurement(
  measurement: StepReplayMeasurement
): void {
  measurement.metrics.stepDeliveryMs +=
    performance.now() - measurement.deliveryStartedAt;
}

export function createWorkflowReplayMetrics(): WorkflowReplayMetrics {
  return {
    eventsConsumed: 0,
    eventCallbackInvocations: 0,
    eventConsumeMs: 0,
    subscriptionWaitCount: 0,
    subscriptionWaitMs: 0,
    completedSteps: 0,
    stepDeliveryMs: 0,
    stepHydrationMs: 0,
    stepHydrationPhases: {
      decryptMs: 0,
      decompressMs: 0,
      telemetryMs: 0,
      deserializeMs: 0,
    },
    stepHydrationCacheHits: 0,
    stepHydrationCacheMisses: 0,
    stepHydrationCacheUnavailable: 0,
    stepHydrationNonMemoizable: 0,
  };
}

export function workflowReplayMetricAttributes(
  metrics: WorkflowReplayMetrics
): Record<string, number> {
  return {
    'workflow.replay.events.consumed': metrics.eventsConsumed,
    'workflow.replay.events.callback_invocations':
      metrics.eventCallbackInvocations,
    'workflow.replay.events.consume_ms': metrics.eventConsumeMs,
    'workflow.replay.events.subscription_wait.count':
      metrics.subscriptionWaitCount,
    'workflow.replay.events.subscription_wait_ms': metrics.subscriptionWaitMs,
    'workflow.replay.steps.completed': metrics.completedSteps,
    'workflow.replay.steps.delivery_ms': metrics.stepDeliveryMs,
    'workflow.replay.steps.hydration_ms': metrics.stepHydrationMs,
    'workflow.replay.steps.hydration.decrypt_ms':
      metrics.stepHydrationPhases.decryptMs,
    'workflow.replay.steps.hydration.decompress_ms':
      metrics.stepHydrationPhases.decompressMs,
    'workflow.replay.steps.hydration.telemetry_ms':
      metrics.stepHydrationPhases.telemetryMs,
    'workflow.replay.steps.hydration.deserialize_ms':
      metrics.stepHydrationPhases.deserializeMs,
    'workflow.replay.steps.hydration.cache_hits':
      metrics.stepHydrationCacheHits,
    'workflow.replay.steps.hydration.cache_misses':
      metrics.stepHydrationCacheMisses,
    'workflow.replay.steps.hydration.cache_unavailable':
      metrics.stepHydrationCacheUnavailable,
    'workflow.replay.steps.hydration.non_memoizable':
      metrics.stepHydrationNonMemoizable,
  };
}
