import { randomUUID } from 'node:crypto';
import type { AnyEventRequest } from '../events.js';
import type { IdempotencyKeyReusePolicy } from '../idempotency.js';
import type { Storage } from '../interfaces.js';
import { runIdempotencyConformance } from './run-idempotency-conformance.js';

/**
 * Exercises the conformance suite itself against a minimal in-memory
 * reference World that implements the `runIdempotencyKeys` contract, so the
 * suite is known to be satisfiable before a real World adopts it. Everything
 * here runs synchronously inside one `create` call, which is what makes each
 * claim atomic.
 */

interface MemoryRun {
  runId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  deploymentId: string;
  workflowName: string;
  idempotencyKey?: string;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryClaim {
  runId: string;
  ttlMs: number;
}

function namedError(name: string, message: string, fields = {}) {
  return Object.assign(new Error(message), { name, ...fields });
}

function createMemoryWorld() {
  let now = Date.now();
  const runs = new Map<string, MemoryRun>();
  const claims = new Map<string, MemoryClaim>();

  function takesOver(
    holder: MemoryRun,
    claim: MemoryClaim,
    policy: IdempotencyKeyReusePolicy
  ): boolean {
    if (holder.status === 'pending' || holder.status === 'running') {
      return false;
    }
    if (now > (holder.completedAt?.getTime() ?? 0) + claim.ttlMs) return true;
    if (policy === 'ALLOW_DUPLICATE') return true;
    if (policy === 'ALLOW_DUPLICATE_FAILED_ONLY') {
      return holder.status !== 'completed';
    }
    return false;
  }

  function refuseUnlessFree(
    scope: string,
    idempotencyKey: string,
    policy: IdempotencyKeyReusePolicy
  ) {
    const claim = claims.get(scope);
    const holder = claim && runs.get(claim.runId);
    if (!claim || !holder || takesOver(holder, claim, policy)) return;
    throw namedError(
      'WorkflowRunAlreadyStartedError',
      `The idempotency key is already held by workflow run "${holder.runId}"`,
      {
        status: 409,
        code: 'idempotency-key-conflict',
        runId: holder.runId,
        runStatus: holder.status,
        workflowName: holder.workflowName,
        idempotencyKey,
      }
    );
  }

  function createRun(
    runId: string,
    data: Extract<AnyEventRequest, { eventType: 'run_created' }>
  ) {
    if (runs.has(runId)) {
      throw namedError('EntityConflictError', 'Workflow run already exists', {
        status: 409,
      });
    }
    const { idempotencyKey, idempotencyKeyTtlMs, idempotencyKeyReusePolicy } =
      data.eventData;
    const scope = `${data.eventData.workflowName}\0${idempotencyKey}`;
    if (idempotencyKey !== undefined) {
      refuseUnlessFree(
        scope,
        idempotencyKey,
        idempotencyKeyReusePolicy ?? 'REJECT_DUPLICATE'
      );
    }
    const at = new Date(now);
    const run: MemoryRun = {
      runId,
      status: 'pending',
      deploymentId: data.eventData.deploymentId,
      workflowName: data.eventData.workflowName,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      createdAt: at,
      updatedAt: at,
    };
    runs.set(runId, run);
    if (idempotencyKey !== undefined) {
      claims.set(scope, { runId, ttlMs: idempotencyKeyTtlMs ?? 86_400_000 });
    }
    return run;
  }

  const TRANSITIONS: Partial<
    Record<AnyEventRequest['eventType'], MemoryRun['status']>
  > = {
    run_started: 'running',
    run_completed: 'completed',
    run_failed: 'failed',
    run_cancelled: 'cancelled',
  };

  function transition(runId: string, data: AnyEventRequest) {
    const run = runs.get(runId);
    if (!run) {
      throw namedError('WorkflowRunNotFoundError', `Run ${runId} not found`);
    }
    const status = TRANSITIONS[data.eventType];
    const at = new Date(now);
    if (status) run.status = status;
    if (status && status !== 'running') run.completedAt = at;
    run.updatedAt = at;
    return run;
  }

  async function create(runId: string, data: AnyEventRequest) {
    const run =
      data.eventType === 'run_created'
        ? createRun(runId, data)
        : transition(runId, data);
    return { event: { runId, eventType: data.eventType }, run: { ...run } };
  }

  async function get(runId: string) {
    const run = runs.get(runId);
    if (!run) {
      throw namedError('WorkflowRunNotFoundError', `Run ${runId} not found`);
    }
    return { ...run };
  }

  return {
    events: { create } as unknown as Storage['events'],
    runs: { get } as unknown as Storage['runs'],
    deleteRun: async (runId: string) => {
      runs.delete(runId);
    },
    advanceClock: (ms: number) => {
      now += ms;
    },
  };
}

const world = createMemoryWorld();

runIdempotencyConformance({
  name: 'in-memory reference',
  events: () => world.events,
  runs: () => world.runs,
  capabilities: () => ({ runIdempotencyKeys: true }),
  newRunId: () => `wrun_${randomUUID().replaceAll('-', '')}`,
  deleteRun: world.deleteRun,
  advanceClock: world.advanceClock,
});
