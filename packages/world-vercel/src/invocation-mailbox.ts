import { AsyncResource } from 'node:async_hooks';
import { EntityConflictError, WorkflowWorldError } from '@workflow/errors';
import { captureInvocationOutcome } from '@workflow/errors/invocation';
import { withResolvers } from '@workflow/utils';
import type { InvocationOutcome } from '@workflow/world';

interface Item {
  fingerprint: string;
  promise: Promise<InvocationOutcome>;
  resolve(outcome: InvocationOutcome): void;
  reject(error: unknown): void;
  process(): Promise<unknown>;
  drive(): Promise<unknown>;
  retain(work: Promise<unknown>): void;
  id: string;
}

interface RunState {
  pending: Item[];
  requests: Map<string, Item>;
  draining: boolean;
  revision: number;
  execution?: Promise<unknown>;
}

/** Per-handler, backend-private RAM handoff. Completion means handler completion. */
export function createInvocationMailbox(
  retain: (work: Promise<unknown>) => void,
  onExecutionError: (error: unknown) => void
) {
  const runs = new Map<string, RunState>();
  let pendingCount = 0;

  const stateFor = (runId: string) => {
    let state = runs.get(runId);
    if (!state) {
      if (runs.size >= 64)
        throw new WorkflowWorldError('Invocation run capacity exceeded', {
          status: 429,
        });
      state = {
        pending: [],
        requests: new Map(),
        draining: false,
        revision: 0,
      };
      runs.set(runId, state);
    }
    return state;
  };
  const cleanup = (runId: string, state: RunState) => {
    if (
      !state.draining &&
      !state.execution &&
      state.requests.size === 0 &&
      runs.get(runId) === state
    ) {
      runs.delete(runId);
    }
  };

  const execute = (
    runId: string,
    run: () => Promise<unknown>
  ): Promise<unknown> => {
    const state = stateFor(runId);
    if (state.execution) return state.execution;
    // Publish the promise before entering user code. Clear execution in the same
    // turn as the final revision check so arrival cannot join an exiting driver.
    state.execution = Promise.resolve().then(async () => {
      try {
        for (;;) {
          const before = state.revision;
          const result = await run();
          if (state.revision === before) return result;
        }
      } finally {
        state.execution = undefined;
        cleanup(runId, state);
      }
    });
    return state.execution;
  };

  const drain = async (runId: string, state: RunState) => {
    try {
      for (;;) {
        const item = state.pending.shift();
        if (!item) return;
        const outcome = await captureInvocationOutcome(item.process);
        state.revision++;
        // Normal execution runs independently of input admission: a step may
        // itself be awaiting this input. Retain it in the host request lifetime.
        const execution = execute(runId, item.drive);
        item.retain(execution.catch(onExecutionError));
        item.resolve(outcome);
        state.requests.delete(item.id);
        pendingCount--;
      }
    } catch (error) {
      for (const item of state.requests.values()) item.reject(error);
      pendingCount -= state.requests.size;
      state.requests.clear();
      state.pending = [];
    } finally {
      state.draining = false;
      cleanup(runId, state);
    }
  };

  return {
    execute,
    submit(
      runId: string,
      id: string,
      fingerprint: string,
      process: () => Promise<unknown>,
      drive: () => Promise<unknown>
    ): Promise<InvocationOutcome> {
      const state = stateFor(runId);
      const existing = state.requests.get(id);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new EntityConflictError(
            'Invocation identity reused with different contents'
          );
        return existing.promise;
      }
      if (pendingCount >= 128 || state.requests.size >= 32) {
        cleanup(runId, state);
        throw new WorkflowWorldError('Invocation mailbox capacity exceeded', {
          status: 429,
        });
      }
      const completion = withResolvers<InvocationOutcome>();
      const item: Item = {
        id,
        fingerprint,
        process: AsyncResource.bind(process),
        drive: AsyncResource.bind(drive),
        retain: AsyncResource.bind(retain),
        promise: completion.promise,
        resolve: completion.resolve,
        reject: completion.reject,
      };
      pendingCount++;
      state.requests.set(id, item);
      state.pending.push(item);
      if (!state.draining) {
        state.draining = true;
        retain(drain(runId, state));
      }
      return completion.promise;
    },
  };
}
