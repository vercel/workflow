/**
 * The queued copy of a `start({ hook })` candidate, as the flow route sees
 * it: its `run_started` carries the reservation and may be the write that
 * admits or refuses the candidate. A refused copy acks without running any
 * code; every other World error keeps its ordinary handling.
 */

import {
  EntityConflictError,
  HookConflictError,
  PreconditionFailedError,
  RUN_ERROR_CODES,
  RunExpiredError,
  START_HOOK_ADMISSION_REJECTED,
  WorkflowWorldError,
} from '@workflow/errors';
import { SPEC_VERSION_CURRENT, type WorkflowRun } from '@workflow/world';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runtimeLogger } from '../logger.js';
import { workflowEntrypoint } from '../runtime.js';
import { dehydrateWorkflowArguments } from '../serialization.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const source = `async function workflow() { return 1; }
  ;globalThis.__private_workflows = new Map();
  globalThis.__private_workflows.set("workflow", workflow);`;

/** Whether the workflow body ran to completion. */
const completed = (created: any[]) =>
  created.some((e) => e.eventType === 'run_completed');

afterEach(() => {
  setWorld(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function deliver(opts: {
  runStarted: (data: any) => Promise<unknown>;
  startHook?: { token: string } | undefined;
  encryptionPublicKey?: string;
  /** Receives every write, for a delivery that throws. */
  sink?: any[];
}) {
  const runId = 'wrun_01K8START0HOOK0CONSUMER000';
  const input = await dehydrateWorkflowArguments([], runId, undefined, []);
  const runEntity: WorkflowRun = {
    runId,
    workflowName: 'workflow',
    status: 'running',
    input,
    attributes: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: new Date(),
    deploymentId: 'test-deployment',
  };
  const created: any[] = [];
  const params: any[] = [];
  const eventsCreate = vi.fn(async (_runId: string, data: any, p?: any) => {
    created.push(data);
    opts.sink?.push(data);
    params.push(p);
    if (data.eventType === 'run_started') {
      await opts.runStarted(data);
      return { run: runEntity, events: [] };
    }
    return {
      event: { ...data, runId, eventId: 'evnt_x', createdAt: new Date() },
    };
  });
  const queue = vi.fn(async () => ({ messageId: null }));
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    getDeploymentId: vi.fn(async () => 'test-deployment'),
    createQueueHandler: vi.fn(
      (_p: string, handler: (m: unknown, md: unknown) => Promise<unknown>) =>
        async () => {
          await handler(
            {
              runId,
              requestedAt: new Date(),
              runInput: {
                input,
                deploymentId: 'test-deployment',
                workflowName: 'workflow',
                specVersion: SPEC_VERSION_CURRENT,
                executionContext: {},
                ...(opts.encryptionPublicKey
                  ? { encryptionPublicKey: opts.encryptionPublicKey }
                  : {}),
                ...(opts.startHook ? { startHook: opts.startHook } : {}),
              },
            },
            {
              requestId: 'req_1',
              attempt: 1,
              queueName: '__wkf_workflow_workflow',
              messageId: 'msg_1',
            }
          );
          return new Response(null, { status: 204 });
        }
    ),
    events: {
      create: eventsCreate,
      list: vi.fn(async () => ({ data: [], hasMore: false, cursor: null })),
    },
    runs: { get: vi.fn(async () => runEntity) },
    queue,
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);

  const response = await (workflowEntrypoint(source)(
    new Request('https://example.test')
  ) as Promise<Response>);
  return { response, created, params, queue };
}

const startHook = { token: 'order:1' };

describe('queued copy of a start Hook candidate', () => {
  it('carries the reservation and the public key on run_started, and is never turbo', async () => {
    // Turbo would run the first step before `run_started` decides admission.
    vi.stubEnv('WORKFLOW_TURBO', '1');
    const { created, params } = await deliver({
      startHook,
      encryptionPublicKey: 'pk_base64',
      runStarted: async () => {},
    });

    const index = created.findIndex((e) => e.eventType === 'run_started');
    // Turbo backgrounds run_started with `skipPreload`; awaited, it preloads.
    expect(params[index]?.skipPreload).not.toBe(true);
    expect(completed(created)).toBe(true);
    const runStarted = created[index];
    expect(runStarted.eventData).toMatchObject({
      startHook,
      encryptionPublicKey: 'pk_base64',
    });
  });

  it('forwards the public key for an ordinary resilient start too', async () => {
    vi.stubEnv('WORKFLOW_TURBO', '0');
    const { created } = await deliver({
      encryptionPublicKey: 'pk_base64',
      runStarted: async () => {},
    });
    const runStarted = created.find((e) => e.eventType === 'run_started');
    expect(runStarted.eventData.encryptionPublicKey).toBe('pk_base64');
    expect(runStarted.eventData.startHook).toBeUndefined();
  });

  it('acks a refused candidate without running anything or failing a run', async () => {
    const info = vi.spyOn(runtimeLogger, 'info');
    const { response, created } = await deliver({
      startHook,
      runStarted: async () => {
        throw new HookConflictError('order:1', 'wrun_owner');
      },
    });

    expect(response.status).toBe(204);
    expect(completed(created)).toBe(false);
    expect(created.map((e) => e.eventType)).toEqual(['run_started']);
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/another run owns the token/),
      expect.objectContaining({ conflictingRunId: 'wrun_owner' })
    );
  });

  it('acks a permanent admission rejection without retrying', async () => {
    const error = vi.spyOn(runtimeLogger, 'error');
    const { response, created } = await deliver({
      startHook,
      runStarted: async () => {
        throw new WorkflowWorldError('disabled', {
          status: 400,
          code: START_HOOK_ADMISSION_REJECTED,
        });
      },
    });

    expect(response.status).toBe(204);
    expect(completed(created)).toBe(false);
    expect(created.map((e) => e.eventType)).toEqual(['run_started']);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/permanently rejected/),
      expect.anything()
    );
  });

  it.each([
    ['EntityConflictError', () => new EntityConflictError('finished')],
    ['RunExpiredError', () => new RunExpiredError('expired')],
  ])('keeps the ordinary %s handling for a start Hook run', async (_name, error) => {
    const info = vi.spyOn(runtimeLogger, 'info');
    await deliver({
      startHook,
      runStarted: async () => {
        throw error();
      },
    });
    expect(info).toHaveBeenCalledWith(
      'Run already finished during setup, skipping',
      expect.anything()
    );
    expect(info).not.toHaveBeenCalledWith(
      expect.stringMatching(/another run owns the token/),
      expect.anything()
    );
  });

  it('does not swallow other World errors for a start Hook run', async () => {
    const result = await deliver({
      startHook,
      runStarted: async () => {
        throw new PreconditionFailedError('stale');
      },
    }).catch((e: unknown) => e);
    // Either rethrown for a queue retry, or recorded as a setup failure:
    // never treated as an admission answer.
    if (result instanceof Error) {
      expect(PreconditionFailedError.is(result)).toBe(true);
    } else {
      const failed = (result as { created: any[] }).created.find(
        (e) => e.eventType === 'run_failed'
      );
      expect(failed?.eventData?.errorCode).not.toBe(
        RUN_ERROR_CODES.WORLD_CONTRACT_ERROR
      );
    }
  });

  describe('a run_started answered without the run', () => {
    const contractError = (body: unknown) => {
      const parsed = z
        .object({
          run: z
            .object({ status: z.string(), startedAt: z.coerce.date() })
            .and(z.object({ startedAt: z.coerce.date() })),
        })
        .safeParse(body);
      assert(!parsed.success);
      return new WorkflowWorldError('v4 createEvent: invalid response body', {
        code: 'SCHEMA_VALIDATION',
        cause: parsed.error,
      });
    };

    it('retries by redelivery, and the redelivery admits and completes', async () => {
      vi.stubEnv('WORKFLOW_TURBO', '0');
      const warn = vi.spyOn(runtimeLogger, 'warn');
      const first = await deliver({
        startHook,
        runStarted: async () => {
          throw contractError({ event: {} });
        },
      }).catch((e: unknown) => e);

      // Rethrown, so the queue redelivers; no run_failed was written.
      expect(WorkflowWorldError.is(first)).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/answered without the run/),
        expect.objectContaining({ workflowRunId: expect.any(String) })
      );

      const { created } = await deliver({
        startHook,
        runStarted: async () => {},
      });
      expect(created.some((e) => e.eventType === 'run_failed')).toBe(false);
      expect(completed(created)).toBe(true);
    });

    it('writes nothing but the run_started it retries', async () => {
      const sink: any[] = [];
      await deliver({
        startHook,
        sink,
        runStarted: async () => {
          throw contractError({ run: null });
        },
      }).catch(() => {});
      expect(sink.map((e) => e.eventType)).toEqual(['run_started']);
    });

    it('keeps every other schema violation fatal', async () => {
      const { created } = await deliver({
        startHook,
        runStarted: async () => {
          throw contractError({ run: { status: 1 } });
        },
      });
      const failed = created.find((e) => e.eventType === 'run_failed');
      expect(failed?.eventData?.errorCode).toBe(
        RUN_ERROR_CODES.WORLD_CONTRACT_ERROR
      );
    });
  });

  it('runs the admitted candidate normally', async () => {
    vi.stubEnv('WORKFLOW_TURBO', '0');
    const { created } = await deliver({
      startHook,
      runStarted: async () => {},
    });
    expect(completed(created)).toBe(true);
  });
});
