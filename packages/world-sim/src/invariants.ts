/**
 * Consistency checks over a finished (or stalled) run.
 *
 * These are the properties the rest of the system assumes without ever
 * verifying: that the log is ordered, that entity rows are a pure fold of the
 * log, that a step is never restarted after it finished, that a terminal run
 * accepts nothing afterwards. The store enforces most of them at write time by
 * rejecting bad events — but "the store rejected it" and "the log is actually
 * consistent" are different claims, and only the second one is worth trusting.
 * So this module re-derives everything from the event log alone and compares.
 *
 * A violation is a bug somewhere: in the runtime that produced the sequence,
 * in the store that accepted it, or in the scenario that injected something
 * impossible. Which one is a question for the reader; the checker's job is
 * only to notice.
 */

import {
  type Event,
  isTerminalRunEventType,
  type Step,
  type Wait,
  type WorkflowRun,
} from '@workflow/world';
import type { InvariantViolation } from './types.js';

export interface InvariantInput {
  runId: string;
  /** The run's events in log order — the order every reader sees them in. */
  events: Event[];
  /**
   * The same events in the order they were *committed*, supplied only by a
   * world that promises the two orders agree — i.e. an append-only log.
   *
   * Only `log.monotonic-order` reads it, and it has to: comparing the sorted
   * array against sort order can only ever pass, which is why that rule was
   * unfirable before. Under a mint-ordered log the field is omitted and the
   * rule is skipped, because there an out-of-order commit is the premise the
   * scenario deliberately injected — production mints ids at the handler
   * boundary, so its log gains rows in the past by design. Asserting otherwise
   * would fail every scenario that holds a write across a peer's commit, which
   * is the setup, not the fault.
   */
  eventsInCommitOrder?: Event[];
  runs: WorkflowRun[];
  steps: Step[];
  waits: Wait[];
}

/** Entity state derived purely from the event log. */
interface DerivedStep {
  stepId: string;
  stepName?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempt: number;
}

export function checkInvariants(input: InvariantInput): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const { runId, events } = input;

  const add = (rule: string, message: string, eventId?: string) => {
    violations.push({ rule, message, runId, eventId });
  };

  // ---- Log shape --------------------------------------------------------

  const seenEventIds = new Set<string>();
  for (const event of events) {
    if (seenEventIds.has(event.eventId)) {
      add(
        'log.unique-event-id',
        `Duplicate eventId ${event.eventId}`,
        event.eventId
      );
    }
    seenEventIds.add(event.eventId);
  }

  // `events.list` sorts by (createdAt, eventId), and replay consumes events in
  // that order. An append-only log promises commit order *is* that order; if it
  // is not, the log gained a row behind a position readers had already passed,
  // so a read taken in between saw a sequence the finished log contradicts.
  // Walking the sorted array could never notice — it is sorted, so it is
  // monotonic by construction. This is the check that the promise was kept.
  let previousKey = '';
  for (const event of input.eventsInCommitOrder ?? []) {
    const key = `${event.createdAt.toISOString()}|${event.eventId}`;
    if (previousKey && key <= previousKey) {
      add(
        'log.monotonic-order',
        `Event ${event.eventId} committed after a peer that sorts above it (${key} <= ${previousKey})`,
        event.eventId
      );
    }
    previousKey = key;
  }

  if (events.length > 0 && events[0].eventType !== 'run_created') {
    add(
      'run.created-first',
      `First event is ${events[0].eventType}, expected run_created`,
      events[0].eventId
    );
  }

  const createdCount = events.filter(
    (e) => e.eventType === 'run_created'
  ).length;
  if (createdCount > 1) {
    add('run.created-once', `${createdCount} run_created events for one run`);
  }

  const terminalIndex = events.findIndex((e) =>
    isTerminalRunEventType(e.eventType)
  );
  if (terminalIndex >= 0 && terminalIndex !== events.length - 1) {
    const trailing = events.slice(terminalIndex + 1);
    // A step that was already running when the run ended is allowed to report
    // its terminal write afterwards; everything else is a contract break.
    const disallowed = trailing.filter(
      (e) => e.eventType !== 'step_completed' && e.eventType !== 'step_failed'
    );
    if (disallowed.length > 0) {
      add(
        'run.terminal-is-last',
        `${disallowed.length} event(s) recorded after the run reached a terminal state: ${disallowed
          .map((e) => e.eventType)
          .join(', ')}`,
        disallowed[0].eventId
      );
    }
  }

  // ---- Step lifecycle ---------------------------------------------------

  const derivedSteps = new Map<string, DerivedStep>();
  for (const event of events) {
    const id = event.correlationId;
    if (!id) continue;

    switch (event.eventType) {
      case 'step_created': {
        if (derivedSteps.has(id)) {
          add('step.created-once', `Step ${id} created twice`, event.eventId);
        }
        derivedSteps.set(id, {
          stepId: id,
          stepName: event.eventData?.stepName,
          status: 'pending',
          attempt: 0,
        });
        break;
      }
      case 'step_started': {
        const step = derivedSteps.get(id);
        if (!step) {
          add(
            'step.started-after-created',
            `step_started for ${id} with no preceding step_created`,
            event.eventId
          );
          break;
        }
        if (step.status === 'completed' || step.status === 'failed') {
          add(
            'step.no-restart-after-terminal',
            `Step ${id} restarted after reaching "${step.status}"`,
            event.eventId
          );
        }
        step.status = 'running';
        step.attempt++;
        break;
      }
      case 'step_completed':
      case 'step_failed': {
        const step = derivedSteps.get(id);
        if (!step) {
          add(
            'step.terminal-after-created',
            `${event.eventType} for ${id} with no preceding step_created`,
            event.eventId
          );
          break;
        }
        if (step.status === 'completed' || step.status === 'failed') {
          add(
            'step.terminal-once',
            `Step ${id} reached a terminal state twice (${step.status} then ${event.eventType})`,
            event.eventId
          );
        }
        step.status =
          event.eventType === 'step_completed' ? 'completed' : 'failed';
        break;
      }
      case 'step_retrying': {
        const step = derivedSteps.get(id);
        if (step) step.status = 'pending';
        break;
      }
      default:
        break;
    }
  }

  // ---- Materialized view agrees with the log ----------------------------

  for (const step of input.steps) {
    const derived = derivedSteps.get(step.stepId);
    if (!derived) {
      add(
        'step.entity-has-log',
        `Step entity ${step.stepId} exists but the log has no step_created for it`
      );
      continue;
    }
    if (derived.status !== step.status) {
      add(
        'step.entity-matches-log',
        `Step ${step.stepId} entity status "${step.status}" disagrees with the log ("${derived.status}")`
      );
    }
    if (derived.attempt !== step.attempt) {
      add(
        'step.attempt-matches-log',
        `Step ${step.stepId} entity attempt ${step.attempt} disagrees with ${derived.attempt} step_started events`
      );
    }
  }

  // ---- Hooks -------------------------------------------------------------

  const createdHooks = new Map<string, string>(); // hookId → token
  const disposedHookIds = new Set<string>();
  const liveTokens = new Map<string, string>(); // token → hookId

  for (const event of events) {
    const id = event.correlationId;
    if (!id) continue;

    switch (event.eventType) {
      case 'hook_created': {
        const token = event.eventData.token;
        const owner = liveTokens.get(token);
        if (owner && owner !== id) {
          add(
            'hook.token-unique',
            `Token "${token}" was granted to hook ${id} while hook ${owner} still held it`,
            event.eventId
          );
        }
        createdHooks.set(id, token);
        liveTokens.set(token, id);
        break;
      }
      case 'hook_received': {
        if (!createdHooks.has(id)) {
          add(
            'hook.received-after-created',
            `hook_received for ${id} with no preceding hook_created`,
            event.eventId
          );
        }
        if (disposedHookIds.has(id)) {
          add(
            'hook.no-receive-after-dispose',
            `hook_received for ${id} after it was disposed`,
            event.eventId
          );
        }
        break;
      }
      case 'hook_disposed': {
        if (disposedHookIds.has(id)) {
          add('hook.dispose-once', `Hook ${id} disposed twice`, event.eventId);
        }
        disposedHookIds.add(id);
        const token = createdHooks.get(id);
        if (token && liveTokens.get(token) === id) liveTokens.delete(token);
        break;
      }
      default:
        break;
    }
  }

  // ---- Waits -------------------------------------------------------------

  const openWaits = new Map<string, Date | undefined>();
  const completedWaits = new Set<string>();
  for (const event of events) {
    const id = event.correlationId;
    if (!id) continue;
    if (event.eventType === 'wait_created') {
      if (openWaits.has(id) || completedWaits.has(id)) {
        add('wait.created-once', `Wait ${id} created twice`, event.eventId);
      }
      openWaits.set(id, event.eventData.resumeAt);
    } else if (event.eventType === 'wait_completed') {
      if (!openWaits.has(id)) {
        add(
          'wait.completed-after-created',
          `wait_completed for ${id} with no preceding wait_created`,
          event.eventId
        );
      }
      if (completedWaits.has(id)) {
        add('wait.completed-once', `Wait ${id} completed twice`, event.eventId);
      }
      const expected = openWaits.get(id);
      const actual = event.eventData?.resumeAt;
      // The workflow's sleep consumer treats a mismatched `resumeAt` as replay
      // divergence, so a world that rewrites it breaks replay rather than
      // merely reporting the wrong time.
      if (
        expected &&
        actual &&
        expected.getTime() !== new Date(actual).getTime()
      ) {
        add(
          'wait.resume-at-stable',
          `wait_completed for ${id} carries resumeAt ${new Date(actual).toISOString()}, but wait_created said ${expected.toISOString()}`,
          event.eventId
        );
      }
      completedWaits.add(id);
      openWaits.delete(id);
    }
  }

  // ---- Attributes are a fold of the log ----------------------------------
  //
  // Attributes are the only mutable run state a workflow writes, and the world
  // materializes them by applying `attr_set` changes in log order. If the
  // materialized map and the log disagree, an observability surface and a
  // replay see different run state.
  const runEntity = input.runs.find((r) => r.runId === runId);
  if (runEntity) {
    const created = events.find((e) => e.eventType === 'run_created');
    const derivedAttributes: Record<string, string> = {
      ...(created?.eventData?.attributes ?? {}),
    };
    for (const event of events) {
      if (event.eventType !== 'attr_set') continue;
      for (const change of event.eventData.changes) {
        if (change.value === null) delete derivedAttributes[change.key];
        else derivedAttributes[change.key] = change.value;
      }
    }
    const actual = runEntity.attributes ?? {};
    const keys = new Set([
      ...Object.keys(derivedAttributes),
      ...Object.keys(actual),
    ]);
    for (const key of keys) {
      if (derivedAttributes[key] !== actual[key]) {
        add(
          'run.attributes-match-log',
          `Attribute ${JSON.stringify(key)} is ${JSON.stringify(actual[key])} on the run entity but ${JSON.stringify(derivedAttributes[key])} by the log`
        );
      }
    }
  }

  // ---- Run entity agrees with the log ------------------------------------

  const run = runEntity;
  if (run) {
    const terminal = events.find((e) => isTerminalRunEventType(e.eventType));
    const expectedStatus = terminal
      ? terminal.eventType === 'run_completed'
        ? 'completed'
        : terminal.eventType === 'run_failed'
          ? 'failed'
          : 'cancelled'
      : events.some((e) => e.eventType === 'run_started')
        ? 'running'
        : 'pending';
    if (run.status !== expectedStatus) {
      add(
        'run.entity-matches-log',
        `Run entity status "${run.status}" disagrees with the log ("${expectedStatus}")`
      );
    }
    if (run.status === 'completed' && run.output === undefined) {
      // `run_completed` may legitimately carry no output (a void workflow), so
      // this only fires when the event had one and the entity lost it.
      const completed = events.find((e) => e.eventType === 'run_completed');
      if (completed?.eventData?.output !== undefined) {
        add('run.output-materialized', 'Completed run entity has no output');
      }
    }
    // Once a run is terminal its hooks and waits are unreachable, so no world
    // should still be holding them.
    if (terminal) {
      const strayWaits = input.waits.filter((w) => w.runId === runId);
      if (strayWaits.length > 0) {
        add(
          'run.resources-released',
          `${strayWaits.length} wait(s) still registered on a terminal run`
        );
      }
    }
  }

  return violations;
}
