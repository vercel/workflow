import type { ActorSnapshot } from './actor-execution.js';
import { ActorInvariantError, assertActorSnapshot } from './actor-execution.js';
import type { Event, EventResult } from './events.js';
import type { Hook } from './hooks.js';
import { WorkflowRunBaseSchema, WorkflowRunSchema } from './runs.js';
import type { Step } from './steps.js';
import type { Wait } from './waits.js';

/** Read model for the isolated actor POC journal. Never repairs its history. */
export function projectActorSnapshot(snapshot: ActorSnapshot) {
  assertActorSnapshot(snapshot);
  let run: ReturnType<typeof WorkflowRunBaseSchema.parse> | undefined;
  const steps = new Map<string, Step>();
  const hooks = new Map<string, Hook>();
  const waits = new Map<string, Wait>();
  const results = new Map<string, EventResult>();
  for (const event of snapshot.events) {
    const at = new Date(event.createdAt);
    const correlationId = event.correlationId;
    let result: EventResult = { event } as EventResult;
    if (event.eventType === 'run_created') {
      run = { ...event.eventData, runId: snapshot.runId, status: 'pending',
        specVersion: event.specVersion, attributes: event.eventData.attributes ?? {},
        createdAt: at, updatedAt: at };
    } else {
      if (!run) throw new ActorInvariantError('Missing run_created');
      if (['completed', 'failed', 'cancelled'].includes(run.status)) {
        throw new ActorInvariantError('Event after terminal run');
      }
      switch (event.eventType) {
        case 'run_started':
          run = { ...run, status: 'running', startedAt: run.startedAt ?? at, updatedAt: at };
          break;
        case 'run_completed':
          run = { ...run, status: 'completed', output: event.eventData.output, completedAt: at, updatedAt: at };
          break;
        case 'run_failed':
          run = { ...run, status: 'failed', ...event.eventData, completedAt: at, updatedAt: at };
          break;
        case 'run_cancelled':
          run = { ...run, status: 'cancelled', completedAt: at, updatedAt: at };
          break;
        case 'attr_set':
          run = { ...run, attributes: { ...run.attributes }, updatedAt: at };
          for (const { key, value } of event.eventData.changes) {
            if (value === null) delete run.attributes[key]; else run.attributes[key] = value;
          }
          break;
        case 'step_created': {
          if (steps.has(correlationId!)) throw new ActorInvariantError('Duplicate step creation');
          steps.set(correlationId!, { runId: snapshot.runId, stepId: correlationId!,
            stepName: event.eventData.stepName, input: event.eventData.input,
            status: 'pending', attempt: 0, createdAt: at, updatedAt: at, specVersion: event.specVersion });
          break;
        }
        case 'step_started':
        case 'step_completed':
        case 'step_failed':
        case 'step_retrying': {
          const step = steps.get(correlationId!);
          if (!step || ['completed', 'failed', 'cancelled'].includes(step.status)) {
            throw new ActorInvariantError('Invalid step lifecycle transition');
          }
          const next = { ...step, updatedAt: at };
          if (event.eventType === 'step_started') {
            next.status = 'running'; next.attempt++; next.startedAt ??= at;
          } else if (event.eventType === 'step_completed') {
            next.status = 'completed'; next.output = event.eventData.result; next.completedAt = at;
          } else if (event.eventType === 'step_failed') {
            next.status = 'failed'; next.error = event.eventData.error; next.completedAt = at;
          } else {
            next.status = 'pending'; next.error = event.eventData.error;
            next.retryAfter = new Date(event.eventData.retryAfter);
          }
          steps.set(correlationId!, next);
          break;
        }
        case 'hook_created':
          if (hooks.has(correlationId!)) throw new ActorInvariantError('Duplicate hook creation');
          hooks.set(correlationId!, { ...event.eventData, hookId: correlationId!, runId: snapshot.runId,
            ...snapshot.tenant,
            createdAt: at, specVersion: event.specVersion,
            resumeContext: { deploymentId: run.deploymentId, workflowName: run.workflowName,
              runSpecVersion: run.specVersion, encryptionPublicKey: run.encryptionPublicKey } });
          break;
        case 'hook_conflict':
          break;
        case 'hook_received':
          if (!hooks.has(correlationId!)) throw new ActorInvariantError('Input for missing or disposed hook');
          break;
        case 'hook_disposed':
          if (!hooks.delete(correlationId!)) throw new ActorInvariantError('Disposal of missing hook');
          break;
        case 'wait_created':
          if (waits.has(correlationId!)) throw new ActorInvariantError('Duplicate wait creation');
          waits.set(correlationId!, { runId: snapshot.runId, waitId: correlationId!, status: 'waiting',
            resumeAt: new Date(event.eventData.resumeAt), createdAt: at, updatedAt: at });
          break;
        case 'wait_completed': {
          const wait = waits.get(correlationId!);
          if (!wait || wait.status !== 'waiting') throw new ActorInvariantError('Completion of missing wait');
          waits.set(correlationId!, { ...wait, status: 'completed', completedAt: at, updatedAt: at });
          break;
        }
        default:
          throw new ActorInvariantError(`Unsupported actor event ${event.eventType}`);
      }
    }
    result = { ...result, run, ...(steps.has(correlationId!) ? { step: steps.get(correlationId!) } : {}),
      ...(hooks.has(correlationId!) ? { hook: hooks.get(correlationId!) } : {}),
      ...(waits.has(correlationId!) ? { wait: waits.get(correlationId!) } : {}) } as EventResult;
    results.set(event.eventId, result);
  }
  if (!run) throw new ActorInvariantError('Empty actor journal');
  return { run: WorkflowRunSchema.parse(run), steps, hooks, waits, results };
}

export function actorEventResult(snapshot: ActorSnapshot, event: Event): EventResult {
  const result = projectActorSnapshot(snapshot).results.get(event.eventId);
  if (!result) throw new ActorInvariantError('Committed receipt is absent from actor snapshot');
  return result;
}
