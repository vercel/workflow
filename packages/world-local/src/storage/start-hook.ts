import type {
  Event,
  Hook,
  HookCreatedEvent,
  StartHook,
  WorkflowRun,
} from '@workflow/world';
import { startHookId } from '@workflow/world';

/**
 * A run's `start({ hook })` Hook (see `start-hook.ts` in @workflow/world).
 * The admission writes it as an ordinary Hook entity with id
 * `startHookId(runId)`; nothing writes a `hook_created` for it, so the run
 * record and its `run_created` are where it can be rebuilt from.
 */

/** The start Hook request as stored: its id filled in from the run's. */
export function withStartHookId(
  startHook: StartHook,
  runId: string
): StartHook {
  return { ...startHook, hookId: startHookId(runId) };
}

/**
 * The start Hook entity of `run`, built from the run record, or null when the
 * run was not admitted with one. Same shape the admission writes.
 */
export function startHookRecord(run: WorkflowRun): Hook | null {
  const startHook = run.startHook;
  if (!startHook) return null;
  return {
    runId: run.runId,
    hookId: startHookId(run.runId),
    token: startHook.token,
    metadata: startHook.metadata,
    ownerId: 'local-owner',
    projectId: 'local-project',
    environment: 'local',
    createdAt: run.createdAt,
    specVersion: run.specVersion,
    isWebhook: false,
    isSystem: false,
    tokenRetentionUntil: startHook.tokenRetentionUntil,
  };
}

/**
 * The `hook_created` a `run_created` carrying a start Hook stands for, or
 * null for any other event. Lets the hook indexes and the log rebuild treat
 * the start Hook like any Hook created by the run.
 */
export function hookCreatedFromRunCreated(
  event: Event
): HookCreatedEvent | null {
  if (event.eventType !== 'run_created') return null;
  const startHook = (event.eventData as { startHook?: StartHook } | undefined)
    ?.startHook;
  if (!startHook || typeof startHook.token !== 'string') return null;
  return {
    eventType: 'hook_created',
    runId: event.runId,
    eventId: event.eventId,
    correlationId: startHookId(event.runId),
    createdAt: event.createdAt,
    specVersion: event.specVersion,
    eventData: {
      token: startHook.token,
      metadata: startHook.metadata,
      tokenRetentionUntil: startHook.tokenRetentionUntil,
      isWebhook: false,
    },
  } as HookCreatedEvent;
}

/** The run id a start Hook id belongs to (`hook_<ulid>` → `wrun_<ulid>`). */
export function runIdOfStartHookId(hookId: string): string | null {
  if (!hookId.startsWith('hook_') || hookId.length <= 'hook_'.length) {
    return null;
  }
  return `wrun_${hookId.slice('hook_'.length)}`;
}
