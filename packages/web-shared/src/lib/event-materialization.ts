/**
 * Event materialization helpers.
 *
 * These functions convert a flat list of workflow events into entity-like
 * objects (steps, hooks, waits) by grouping events by correlationId and
 * stitching together lifecycle events.
 *
 * This enables a "top-down" data fetching pattern where the client fetches
 * all events for a run once, then materializes entities client-side instead
 * of making separate API calls for each entity type.
 */

import type { Event, StepStatus } from '@workflow/world';

// ---------------------------------------------------------------------------
// Materialized entity types
// ---------------------------------------------------------------------------

export interface MaterializedStep {
  stepId: string;
  runId: string;
  stepName: string;
  status: StepStatus;
  attempt: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  updatedAt: Date;
  /** All events for this step, in insertion order */
  events: Event[];
}

export interface MaterializedHook {
  hookId: string;
  runId: string;
  token?: string;
  createdAt: Date;
  receivedCount: number;
  lastReceivedAt?: Date;
  disposedAt?: Date;
  /** All events for this hook, in insertion order */
  events: Event[];
}

export interface MaterializedWait {
  waitId: string;
  runId: string;
  status: 'waiting' | 'completed';
  createdAt: Date;
  resumeAt?: Date;
  completedAt?: Date;
  /** All events for this wait, in insertion order */
  events: Event[];
}

export interface MaterializedEntities {
  steps: MaterializedStep[];
  hooks: MaterializedHook[];
  waits: MaterializedWait[];
}

// ---------------------------------------------------------------------------
// Helper: group events by correlationId prefix
// ---------------------------------------------------------------------------

function groupByCorrelationId(
  events: Event[],
  prefixes: string[]
): Map<string, Event[]> {
  const groups = new Map<string, Event[]>();
  for (const event of events) {
    const cid = event.correlationId;
    if (!cid) continue;
    if (!prefixes.some((p) => cid.startsWith(p))) continue;
    const existing = groups.get(cid);
    if (existing) {
      existing.push(event);
    } else {
      groups.set(cid, [event]);
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// materializeSteps
// ---------------------------------------------------------------------------

/**
 * Group step_* events by correlationId and build Step-like entities.
 *
 * Handles partial event lists gracefully: a step may only have a
 * step_created event with no completion yet.
 */
export function materializeSteps(events: Event[]): MaterializedStep[] {
  const groups = groupByCorrelationId(events, ['step_']);
  const steps: MaterializedStep[] = [];

  for (const [correlationId, stepEvents] of groups) {
    const created = stepEvents.find((e) => e.eventType === 'step_created');
    if (!created) continue;

    let status: StepStatus = 'pending';
    let attempt = 0;
    let startedAt: Date | undefined;
    let completedAt: Date | undefined;
    let updatedAt = created.createdAt;

    for (const e of stepEvents) {
      switch (e.eventType) {
        case 'step_started':
          status = 'running';
          attempt += 1;
          if (!startedAt) startedAt = e.createdAt;
          completedAt = undefined;
          updatedAt = e.createdAt;
          break;
        case 'step_completed':
          status = 'completed';
          completedAt = e.createdAt;
          updatedAt = e.createdAt;
          break;
        case 'step_failed':
          status = 'failed';
          completedAt = e.createdAt;
          updatedAt = e.createdAt;
          break;
        case 'step_retrying':
          status = 'pending';
          completedAt = undefined;
          updatedAt = e.createdAt;
          break;
      }
    }

    steps.push({
      stepId: correlationId,
      runId: created.runId,
      stepName:
        created.eventType === 'step_created'
          ? (created.eventData?.stepName ?? correlationId)
          : correlationId,
      status,
      attempt,
      createdAt: created.createdAt,
      startedAt,
      completedAt,
      updatedAt,
      events: stepEvents,
    });
  }

  return steps;
}

// ---------------------------------------------------------------------------
// materializeHooks
// ---------------------------------------------------------------------------

/**
 * Group hook_* events by correlationId and build Hook-like entities.
 */
export function materializeHooks(events: Event[]): MaterializedHook[] {
  const groups = groupByCorrelationId(events, ['hook_']);
  const hooks: MaterializedHook[] = [];

  for (const [correlationId, hookEvents] of groups) {
    const created = hookEvents.find((e) => e.eventType === 'hook_created');
    if (!created) continue;

    const receivedEvents = hookEvents.filter(
      (e) => e.eventType === 'hook_received'
    );
    const disposed = hookEvents.find((e) => e.eventType === 'hook_disposed');
    const lastReceived = receivedEvents.at(-1);

    hooks.push({
      hookId: correlationId,
      runId: created.runId,
      token:
        created.eventType === 'hook_created'
          ? created.eventData?.token
          : undefined,
      createdAt: created.createdAt,
      receivedCount: receivedEvents.length,
      lastReceivedAt: lastReceived?.createdAt,
      disposedAt: disposed?.createdAt,
      events: hookEvents,
    });
  }

  return hooks;
}

// ---------------------------------------------------------------------------
// materializeWaits
// ---------------------------------------------------------------------------

/**
 * Group wait_* events by correlationId and build Wait-like entities.
 */
export function materializeWaits(events: Event[]): MaterializedWait[] {
  const groups = groupByCorrelationId(events, ['wait_']);
  const waits: MaterializedWait[] = [];

  for (const [correlationId, waitEvents] of groups) {
    const created = waitEvents.find((e) => e.eventType === 'wait_created');
    if (!created) continue;

    const completed = waitEvents.find((e) => e.eventType === 'wait_completed');

    waits.push({
      waitId: correlationId,
      runId: created.runId,
      status: completed ? 'completed' : 'waiting',
      createdAt: created.createdAt,
      resumeAt:
        created.eventType === 'wait_created'
          ? created.eventData?.resumeAt
          : undefined,
      completedAt: completed?.createdAt,
      events: waitEvents,
    });
  }

  return waits;
}

// ---------------------------------------------------------------------------
// materializeAll
// ---------------------------------------------------------------------------

/**
 * Convenience function that materializes all entity types from a flat
 * event list.
 */
export function materializeAll(events: Event[]): MaterializedEntities {
  return {
    steps: materializeSteps(events),
    hooks: materializeHooks(events),
    waits: materializeWaits(events),
  };
}
