/**
 * The World as seen by any code in the Worker: route handlers that call
 * `start()`/`resumeHook()`, step runners, and the run objects themselves.
 *
 * Every run-scoped call goes to the run's Durable Object. When the caller is
 * already executing inside that object (the workflow itself, or an inline
 * step), the call is served in-process; otherwise it is a Workers RPC.
 */
import { HookNotFoundError, WorkflowWorldError } from '@workflow/errors';
import { unwrapInvocationOutcome } from '@workflow/errors/invocation';
import type {
  CreateEventParams,
  Event,
  EventResult,
  GetChunksOptions,
  Hook,
  InvokeOptions,
  ListEventsByCorrelationIdParams,
  ListEventsParams,
  ListHooksParams,
  ListWorkflowRunStepsParams,
  MessageId,
  PaginatedResponse,
  QueueOptions,
  QueuePayload,
  SnapshotMetadata,
  StreamChunksResponse,
  StreamInfoResponse,
  ValidQueueName,
  World,
} from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { ulid } from 'ulid';
import { getEncryptionKeyForRun } from './encryption.js';
import { call, RUNS_BINDING, STREAMS_BINDING, TOKENS_BINDING } from './rpc.js';
import {
  createQueueHandler,
  currentLocalRun,
  getRuntimeConfig,
} from './runtime.js';

/** Methods a run object serves, locally or over RPC. */
export interface RunApi {
  eventsCreate(
    runId: string,
    data: unknown,
    params?: CreateEventParams
  ): Promise<EventResult>;
  eventsGet(runId: string, eventId: string, params?: unknown): Promise<Event>;
  eventsList(params: ListEventsParams): Promise<PaginatedResponse<Event>>;
  eventsListByCorrelationId(
    params: ListEventsByCorrelationIdParams
  ): Promise<PaginatedResponse<Event>>;
  runsGet(runId: string, params?: unknown): Promise<unknown>;
  stepsGet(runId: string, stepId: string, params?: unknown): Promise<unknown>;
  stepsList(params: ListWorkflowRunStepsParams): Promise<unknown>;
  hooksGet(hookId: string, params?: unknown): Promise<Hook>;
  hooksList(params: ListHooksParams): Promise<PaginatedResponse<Hook>>;
  enqueue(
    queueName: ValidQueueName,
    message: QueuePayload,
    opts?: QueueOptions
  ): Promise<{ messageId: MessageId | null }>;
  invoke(
    runId: string,
    payload: unknown,
    options?: InvokeOptions
  ): Promise<unknown>;
  snapshotSave(
    runId: string,
    data: Uint8Array,
    metadata: SnapshotMetadata
  ): Promise<void>;
  snapshotLoad(
    runId: string
  ): Promise<{ data: Uint8Array; metadata: SnapshotMetadata } | null>;
  snapshotDelete(runId: string): Promise<void>;
}

type RunMethod = keyof RunApi;

/** Health checks name no run; each probe gets a throwaway object of its own. */
export function probeObjectName(correlationId: string): string {
  return `probe:${correlationId}`;
}

async function onRun<M extends RunMethod>(
  runId: string,
  method: M,
  ...args: Parameters<RunApi[M]>
): Promise<Awaited<ReturnType<RunApi[M]>>> {
  const local = currentLocalRun();
  if (local && local.runId === runId) {
    const api = (local.object as { api: RunApi }).api;
    return (api[method] as (...a: unknown[]) => Promise<never>)(
      ...args
    ) as never;
  }
  return call<never>(RUNS_BINDING, runId, 'call', method, args);
}

function unsupported(what: string): never {
  throw new WorkflowWorldError(
    `world-cloudflare: ${what} is not supported by this proof of concept`,
    { status: 501 }
  );
}

function streamObject(runId: string, name: string): string {
  return `stream:${runId}:${name}`;
}

function streamIndexObject(runId: string): string {
  return `streams:${runId}`;
}

const encoder = new TextEncoder();
const toBytes = (chunk: string | Uint8Array): Uint8Array =>
  typeof chunk === 'string' ? encoder.encode(chunk) : chunk;

export function createCloudflareWorld(): World {
  const streams: World['streams'] = {
    async write(runId, name, chunk) {
      await call(STREAMS_BINDING, streamIndexObject(runId), 'register', name);
      await call(STREAMS_BINDING, streamObject(runId, name), 'append', [
        toBytes(chunk),
      ]);
    },
    async writeMulti(runId, name, chunks) {
      await call(STREAMS_BINDING, streamIndexObject(runId), 'register', name);
      await call(
        STREAMS_BINDING,
        streamObject(runId, name),
        'append',
        chunks.map(toBytes)
      );
    },
    async close(runId, name) {
      await call(STREAMS_BINDING, streamIndexObject(runId), 'register', name);
      await call(STREAMS_BINDING, streamObject(runId, name), 'close');
    },
    async list(runId) {
      return call(STREAMS_BINDING, streamIndexObject(runId), 'names');
    },
    async getChunks(runId, name, options?: GetChunksOptions) {
      return call<StreamChunksResponse>(
        STREAMS_BINDING,
        streamObject(runId, name),
        'chunks',
        options ?? {}
      );
    },
    async getInfo(runId, name) {
      return call<StreamInfoResponse>(
        STREAMS_BINDING,
        streamObject(runId, name),
        'info'
      );
    },
    async get(runId, name, startIndex = 0) {
      let next = startIndex;
      if (next < 0) {
        const info = await streams.getInfo(runId, name);
        next = Math.max(0, info.tailIndex + 1 + next);
      }
      let cancelled = false;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          while (!cancelled) {
            const page = await streams.getChunks(runId, name, {
              cursor: String(next),
              limit: 100,
            });
            if (page.data.length > 0) {
              for (const chunk of page.data) controller.enqueue(chunk.data);
              next += page.data.length;
              return;
            }
            if (page.done) {
              controller.close();
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        },
        cancel() {
          cancelled = true;
        },
      });
    },
  };

  const world: World = {
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: {
      // At most one runner per run: every ordinary delivery for a run is
      // executed by that run's Durable Object, one at a time. See run-object.ts.
      invoke: true,
    },

    getEncryptionKeyForRun:
      getEncryptionKeyForRun as World['getEncryptionKeyForRun'],

    // VM snapshots live in the run's object next to its event log, so a
    // snapshot and the log position it was taken at can never disagree.
    experimental_snapshots: {
      save: (runId, data, metadata) =>
        onRun(runId, 'snapshotSave', runId, data, metadata),
      load: (runId) => onRun(runId, 'snapshotLoad', runId),
      delete: (runId) => onRun(runId, 'snapshotDelete', runId),
    },

    async getDeploymentId() {
      return getRuntimeConfig().deploymentId;
    },

    createQueueHandler,

    async queue(queueName, message, opts) {
      const runId = (message as { runId?: unknown }).runId;
      if (typeof runId === 'string') {
        return onRun(runId, 'enqueue', queueName, message, opts);
      }
      if ('__healthCheck' in message && message.__healthCheck) {
        return call(
          RUNS_BINDING,
          probeObjectName(message.correlationId),
          'call',
          'enqueue',
          [queueName, message, opts]
        );
      }
      return unsupported('a queue message without a runId');
    },

    async invoke(runId, payload, options) {
      const outcome = await onRun(runId, 'invoke', runId, payload, options);
      return unwrapInvocationOutcome(outcome);
    },

    runs: {
      get: ((runId: string, params?: unknown) =>
        onRun(runId, 'runsGet', runId, params)) as World['runs']['get'],
      list: (() => unsupported('runs.list')) as World['runs']['list'],
    },

    steps: {
      get: ((runId: string, stepId: string, params?: unknown) =>
        onRun(
          runId,
          'stepsGet',
          runId,
          stepId,
          params
        )) as World['steps']['get'],
      list: ((params: ListWorkflowRunStepsParams) =>
        onRun(params.runId, 'stepsList', params)) as World['steps']['list'],
    },

    events: {
      create: (async (
        runId: string | null,
        data: unknown,
        params?: CreateEventParams
      ) => {
        const id = runId || `wrun_${ulid()}`;
        return onRun(id, 'eventsCreate', id, data, params);
      }) as World['events']['create'],
      get: (runId, eventId, params) =>
        onRun(runId, 'eventsGet', runId, eventId, params),
      list: (params) => onRun(params.runId, 'eventsList', params),
      listByCorrelationId: (params) =>
        onRun(params.runId, 'eventsListByCorrelationId', params),
    },

    hooks: {
      async get(hookId, params) {
        const local = currentLocalRun();
        if (local) {
          try {
            return await onRun(local.runId, 'hooksGet', hookId, params);
          } catch (error) {
            // Not this run's hook: fall through to the index.
            if (!HookNotFoundError.is(error)) throw error;
          }
        }
        const owner = await call<{ runId: string } | null>(
          TOKENS_BINDING,
          `hook:${hookId}`,
          'lookup'
        );
        if (!owner) throw new HookNotFoundError(hookId);
        return onRun(owner.runId, 'hooksGet', hookId, params);
      },
      async getByToken(token, params) {
        const owner = await call<{ runId: string; hookId: string } | null>(
          TOKENS_BINDING,
          `token:${token}`,
          'lookup'
        );
        if (!owner) throw new HookNotFoundError(token);
        try {
          return await onRun(owner.runId, 'hooksGet', owner.hookId, params);
        } catch (error) {
          if (HookNotFoundError.is(error)) throw new HookNotFoundError(token);
          throw error;
        }
      },
      async list(params) {
        if (!params.runId) return unsupported('hooks.list without a runId');
        return onRun(params.runId, 'hooksList', params);
      },
    },

    streams,
  };
  return world;
}
