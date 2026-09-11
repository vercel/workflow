import { randomUUID } from 'node:crypto';
import {
  HookNotFoundError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  assertExecutionSnapshot,
  type CreateEventRequest,
  type EventResult,
  EXECUTION_PROFILE,
  ExecutionInvariantError,
  ExecutionReceiptSchema,
  type ExecutionSnapshot,
  ExecutionSnapshotSchema,
  type ExecutionStorage,
  executionEventResult,
  getQueueTopicPrefix,
  projectExecutionSnapshot,
  type RunCreatedEventRequest,
  resolveQueueNamespace,
  type World,
} from '@workflow/world';
import {
  type APIConfig,
  createQueue,
  createWorld as createVercelWorld,
  regionForRunId,
} from '@workflow/world-vercel';
import { makeRequest } from '@workflow/world-vercel/actor-client';
import { z } from 'zod';
import { createActorHandler } from './actor.js';

/** The platform header name is deliberately not guessed. */
export const AFFINITY_HEADER_ENV = 'WORKFLOW_ACTOR_AFFINITY_HEADER';
export function affinityHeaders(
  runId: string,
  name = process.env[AFFINITY_HEADER_ENV]
): Record<string, string> {
  if (
    !name ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
    [
      'authorization',
      'host',
      'content-type',
      'content-length',
      'cookie',
    ].includes(name.toLowerCase())
  ) {
    throw new Error(
      `${AFFINITY_HEADER_ENV} must name the platform affinity header`
    );
  }
  return { [name]: runId };
}

export interface ActorWorldConfig extends APIConfig {
  affinityHeader?: string;
  submitTimeoutMs?: number;
}

export function createWorld(config: ActorWorldConfig = {}): World {
  const base = createVercelWorld(config);
  const prefix = (runId: string) =>
    `/v1/actor-executions/${encodeURIComponent(runId)}`;
  const read = async (runId: string): Promise<ExecutionSnapshot> => {
    try {
      const snapshot = await makeRequest({
        endpoint: `${prefix(runId)}/snapshot`,
        options: { method: 'GET' },
        config,
        schema: ExecutionSnapshotSchema,
      });
      assertExecutionSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      if (WorkflowWorldError.is(error) && error.status === 404)
        throw new WorkflowRunNotFoundError(runId);
      throw error;
    }
  };
  const wake: World['queue'] = async (queueName, payload, options) => {
    if (!('runId' in payload) || typeof payload.runId !== 'string') {
      throw new Error('Actor POC queues accept only run-addressed deliveries');
    }
    const snapshot = await read(payload.runId);
    if (regionForRunId(payload.runId) !== 'iad1')
      throw new Error('Actor POC currently requires iad1');
    if (
      options?.deploymentId &&
      options.deploymentId !== snapshot.deploymentId
    ) {
      throw new Error('Actor delivery must target the pinned deployment');
    }
    return base.queue(queueName, payload, {
      ...options,
      deploymentId: snapshot.deploymentId,
      headers: {
        ...options?.headers,
        ...affinityHeaders(payload.runId, config.affinityHeader),
      },
    });
  };
  const execution: ExecutionStorage = {
    profile: EXECUTION_PROFILE,
    createHandler(factory, options) {
      return createActorHandler(
        world,
        factory,
        () => config.affinityHeader ?? process.env[AFFINITY_HEADER_ENV],
        options?.namespace
      );
    },
    async create(runId, event) {
      affinityHeaders(runId, config.affinityHeader); // Fail configuration before persistence.
      if (regionForRunId(runId) !== 'iad1')
        throw new Error('Actor POC currently requires iad1');
      await makeRequest({
        endpoint: `${prefix(runId)}/create`,
        options: { method: 'POST' },
        config,
        data: {
          deploymentId: event.eventData.deploymentId,
          activationId: 'creator',
          operationId: 'create',
          expectedHead: 0,
          events: [event],
        },
        schema: ExecutionReceiptSchema,
      });
      return read(runId);
    },
    async acquire(runId) {
      const snapshot = await read(runId);
      if (snapshot.deploymentId !== (await base.getDeploymentId())) {
        const message = 'Primary reached the wrong deployment';
        await execution.quarantine(runId, {
          code: 'EXECUTION_INVARIANT_VIOLATION',
          message,
        });
        throw new ExecutionInvariantError(message);
      }
      return snapshot;
    },
    async exchange({ runId, ...data }) {
      return makeRequest({
        endpoint: `${prefix(runId)}/exchange`,
        options: { method: 'POST' },
        config,
        data,
        schema: ExecutionReceiptSchema,
      });
    },
    async receipt(runId, operationId) {
      try {
        return await makeRequest({
          endpoint: `${prefix(runId)}/receipts/${encodeURIComponent(operationId)}`,
          options: { method: 'GET' },
          config,
          schema: ExecutionReceiptSchema,
        });
      } catch (error) {
        if (WorkflowWorldError.is(error) && error.status === 404)
          return undefined;
        throw error;
      }
    },
    async submit(runId, event, params) {
      const snapshot = await read(runId);
      const operationId = params?.resumeId ?? randomUUID();
      const run = projectExecutionSnapshot(snapshot).run;
      const queueName = `${getQueueTopicPrefix('workflow', resolveQueueNamespace())}${run.workflowName}`;
      await wake(
        queueName as Parameters<World['queue']>[0],
        { runId, executionInput: { operationId, event } },
        { deploymentId: run.deploymentId }
      );
      const expires = Date.now() + (config.submitTimeoutMs ?? 60_000);
      while (true) {
        try {
          const receipt = await makeRequest({
            endpoint: `${prefix(runId)}/receipts/${encodeURIComponent(operationId)}`,
            options: { method: 'GET' },
            config,
            schema: ExecutionReceiptSchema,
          });
          const current = await read(runId);
          return executionEventResult(
            current,
            receipt.events[receipt.events.length - 1]
          ) as EventResult<typeof event.eventType>;
        } catch (error) {
          if (!(WorkflowWorldError.is(error) && error.status === 404))
            throw error;
          if (Date.now() >= expires)
            throw new Error(
              `Actor submission outcome unknown; operationId=${operationId}`
            );
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    },
    async quarantine(runId, fault) {
      await makeRequest({
        endpoint: `${prefix(runId)}/fault`,
        options: { method: 'POST' },
        config,
        data: fault,
        schema: z.object({ quarantined: z.literal(true) }),
      });
    },
  };
  const unsupported = async (): Promise<never> => {
    throw new Error('Not supported by the world-vercel-actors POC');
  };
  const world: World = {
    ...base,
    execution,
    queue: wake,
    analytics: undefined,
    createQueueHandler: createQueue(config, { eventsChannel: false })
      .createQueueHandler,
    capabilities: { deploymentAffinity: true },
    // Reads come from the same journal, never stale legacy projections.
    runs: {
      get: async (id: string) => projectExecutionSnapshot(await read(id)).run,
      list: unsupported,
    } as World['runs'],
    events: {
      create: async (
        runId: string | null,
        event: CreateEventRequest | RunCreatedEventRequest,
        params?: Parameters<ExecutionStorage['submit']>[2]
      ) => {
        if (!runId)
          throw new Error('Actor runs require client-generated run IDs');
        if (event.eventType === 'run_created') {
          const snapshot = await execution.create(runId, event);
          return executionEventResult(snapshot, snapshot.events[0]);
        }
        return execution.submit(runId, event, params);
      },
      get: async (runId: string, eventId: string) => {
        const event = (await read(runId)).events.find(
          (e) => e.eventId === eventId
        );
        if (!event)
          throw new WorkflowWorldError('Actor event not found', {
            status: 404,
          });
        return event;
      },
      list: async ({ runId }) => ({
        data: (await read(runId)).events,
        cursor: null,
        hasMore: false,
      }),
      listByCorrelationId: async ({ runId, correlationId }) => ({
        data: (await read(runId)).events.filter(
          (e) => e.correlationId === correlationId
        ),
        cursor: null,
        hasMore: false,
      }),
    } as World['events'],
    steps: {
      get: async (runId, stepId) => {
        const step = projectExecutionSnapshot(await read(runId)).steps.get(
          stepId
        );
        if (!step)
          throw new WorkflowWorldError('Actor step not found', { status: 404 });
        return step;
      },
      list: async ({ runId }) => ({
        data: [...projectExecutionSnapshot(await read(runId)).steps.values()],
        cursor: null,
        hasMore: false,
      }),
    } as World['steps'],
    hooks: {
      get: unsupported,
      async getByToken(token) {
        const binding = await makeRequest({
          endpoint: `/v1/actor-executions/hooks/by-token?token=${encodeURIComponent(token)}`,
          options: { method: 'GET' },
          config,
          schema: z.object({ runId: z.string(), hookId: z.string() }),
        });
        const view = projectExecutionSnapshot(await read(binding.runId));
        const hook = view.hooks.get(binding.hookId);
        if (!hook || !['pending', 'running'].includes(view.run.status))
          throw new HookNotFoundError(token);
        return hook;
      },
      list: async ({ runId }) => {
        if (!runId) throw new Error('Actor hook listing requires a run ID');
        return {
          data: [...projectExecutionSnapshot(await read(runId)).hooks.values()],
          cursor: null,
          hasMore: false,
        };
      },
    },
    // The POC has no shared native run projections. Fail explicitly instead of
    // delegating streams to a legacy store that cannot see these runs.
    streams: {
      write: unsupported,
      close: unsupported,
      get: unsupported,
      list: unsupported,
      getChunks: unsupported,
      getInfo: unsupported,
    },
  };
  return world;
}
