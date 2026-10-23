import {
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import { workflowEntrypoint } from '../runtime.js';
import { dehydrateWorkflowArguments } from '../serialization.js';
import { CHILD_RUN_COMPLETION_CONTEXT_KEY } from './child-run-completion.js';
import { notifyParentOfRunCompletion } from './child-run-completion-notify.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./child-run-completion-notify.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('./child-run-completion-notify.js')
  >()),
  notifyParentOfRunCompletion: vi.fn().mockResolvedValue(undefined),
}));

/**
 * The runtime that records a child run's terminal event resumes its parent's
 * completion hook, and only after the write: the parent reads the child once
 * after registering the hook, so a resume that lands before the terminal
 * write (and finds no hook) could leave the parent waiting forever.
 */
describe.each([
  'node',
  'quickjs',
] as const)('%s terminal writes resume the parent completion hook', (engine) => {
  afterEach(() => {
    setWorld(undefined);
    vi.restoreAllMocks();
    vi.mocked(notifyParentOfRunCompletion).mockClear();
  });

  async function runChild(body: string) {
    const runId = 'wrun_child_terminal';
    const workflowRun: WorkflowRun = {
      runId,
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments([], runId, undefined, []),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
      specVersion: SPEC_VERSION_CURRENT,
      executionContext: {
        [CHILD_RUN_COMPLETION_CONTEXT_KEY]: true,
        ...(engine === 'quickjs' ? { workflowVm: 'quickjs' } : {}),
      },
    };
    const events: Event[] = [];
    const written: string[] = [];
    const create = vi.fn(async (_runId: string, data: any) => {
      written.push(data.eventType);
      if (data.eventType === 'run_started') {
        return { run: workflowRun, events };
      }
      return {
        event: {
          eventId: 'evnt_written',
          runId,
          createdAt: new Date(),
          ...data,
        },
      };
    });
    vi.mocked(notifyParentOfRunCompletion).mockImplementation(async () => {
      written.push('notify');
    });

    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      capabilities: {},
      getDeploymentId: vi.fn(async () => workflowRun.deploymentId),
      createQueueHandler:
        (_prefix: string, handler: (m: unknown, meta: unknown) => unknown) =>
        async () => {
          await handler(
            { runId, requestedAt: new Date('2024-01-01T00:00:00.000Z') },
            {
              requestId: 'req_test',
              attempt: 1,
              queueName: '__wkf_workflow_workflow',
              messageId: 'msg_test',
            }
          );
          return new Response(null, { status: 204 });
        },
      events: {
        create,
        list: vi.fn(async () => ({
          data: events,
          hasMore: false,
          cursor: null,
        })),
      },
      runs: { get: vi.fn(async () => workflowRun) },
      queue: vi.fn(async () => ({ messageId: null })),
      getEncryptionKeyForRun: vi.fn(async () => undefined),
    } as any);

    await workflowEntrypoint(
      `async function workflow() { ${body} }
      globalThis.__private_workflows = new Map([['workflow', workflow]]);`
    )(new Request('https://example.test'));

    return { workflowRun, written };
  }

  it('after run_completed', async () => {
    const { workflowRun, written } = await runChild(`return 'done';`);

    expect(notifyParentOfRunCompletion).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({
        runId: workflowRun.runId,
        executionContext: workflowRun.executionContext,
      }),
      'completed'
    );
    expect(written.slice(-2)).toEqual(['run_completed', 'notify']);
  });

  it('after run_failed', async () => {
    vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
    const { written } = await runChild(`throw new Error('child failed');`);

    expect(notifyParentOfRunCompletion).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.anything(),
      'failed'
    );
    expect(written.slice(-2)).toEqual(['run_failed', 'notify']);
  });
});
