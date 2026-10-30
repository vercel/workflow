import {
  HookConflictError,
  RUN_ERROR_CODES,
  START_HOOK_ADMISSION_DISABLED,
  START_HOOK_ADMISSION_REJECTED,
  ThrottleError,
  WorkflowRunNotFoundError,
  WorkflowStartError,
  WorkflowWorldError,
} from '@workflow/errors';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import { START_HOOK_CONFIRM_DELAYS_MS, start } from './start.js';
import {
  ackRefusedStartHookCandidate,
  recordAcceptedStartHookCandidate,
} from './start-hook-delivery.js';
import {
  START_HOOK_HOLDER_WAKE_AFTER_MS,
  wakePendingStartHookHolder,
} from './start-hook-holder.js';
import { setWorld } from './world.js';

/**
 * What `start({ hook })`, its queued copy and the holder wake record for an
 * operator: the start span's outcome attributes, the invocation span of a
 * queued copy, and the logs that say why.
 */

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const spanAttributes: Record<string, unknown> = {};
const fakeSpan = () =>
  ({
    setAttributes: (attrs: Record<string, unknown>) => {
      Object.assign(spanAttributes, attrs);
    },
  }) as any;

vi.mock('../telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telemetry.js')>()),
  serializeTraceCarrier: vi.fn().mockResolvedValue({}),
  trace: vi.fn((_name, fn) => fn(fakeSpan())),
  getActiveSpan: vi.fn().mockResolvedValue(undefined),
}));

const workflow = { workflowId: 'workflow//./test//orders' };
const TOKEN = 'order:telemetry';

let eventsCreate: ReturnType<typeof vi.fn>;
let queue: ReturnType<typeof vi.fn>;

function admittingWorld(overrides: Record<string, unknown> = {}) {
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
    capabilities: {
      inBandFence: true,
      atomicStartHook: { active: true },
      hookRetention: { active: true },
    },
    events: { create: eventsCreate },
    queue,
    runs: { get: vi.fn().mockRejectedValue(new WorkflowRunNotFoundError('x')) },
    ...overrides,
  } as any);
}

const accept = async (runId: string, event: any) => ({
  run: { runId, status: 'pending', startHook: event.eventData.startHook },
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected start() to throw');
    },
    (error: unknown) => error
  );
}

beforeEach(() => {
  for (const key of Object.keys(spanAttributes)) delete spanAttributes[key];
  eventsCreate = vi.fn(accept);
  queue = vi.fn(async () => {});
});

afterEach(() => {
  setWorld(undefined);
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('the workflow.start span of start({ hook })', () => {
  it('records the run id, the outcome and no confirmation for a clean admission', async () => {
    admittingWorld();
    const run = await start(workflow, [], { hook: { token: TOKEN } });
    expect(spanAttributes).toMatchObject({
      'workflow.run.id': run.runId,
      'workflow.start_hook': true,
      'workflow.start_hook.outcome': 'accepted',
      'workflow.start_hook.confirm_attempts': 0,
    });
    expect(spanAttributes).not.toHaveProperty(
      'workflow.start_hook.enqueue_failed'
    );
    expect(spanAttributes).not.toHaveProperty('workflow.start_hook.error_code');
  });

  it('keeps enqueue_failed on a start whose message was published again after admission', async () => {
    queue
      .mockRejectedValueOnce(new ThrottleError('busy'))
      .mockResolvedValue(undefined);
    admittingWorld();
    await start(workflow, [], { hook: { token: TOKEN } });
    expect(queue).toHaveBeenCalledTimes(2);
    expect(spanAttributes).toMatchObject({
      'workflow.start_hook.outcome': 'accepted',
      'workflow.start_hook.enqueue_failed': true,
    });
  });

  it('counts the re-posts that confirmed an admission in place', async () => {
    eventsCreate
      .mockRejectedValueOnce(new WorkflowWorldError('lost', { status: 503 }))
      .mockImplementation(accept);
    admittingWorld();
    await start(workflow, [], { hook: { token: TOKEN } });
    expect(spanAttributes).toMatchObject({
      'workflow.start_hook.outcome': 'accepted',
      'workflow.start_hook.confirm_attempts': 1,
    });
  });

  it('records a refusal as rejected, naming the owner, with no error code', async () => {
    eventsCreate.mockRejectedValue(new HookConflictError(TOKEN, 'wrun_owner'));
    admittingWorld();
    expect(
      HookConflictError.is(
        await rejection(start(workflow, [], { hook: { token: TOKEN } }))
      )
    ).toBe(true);
    expect(spanAttributes).toMatchObject({
      'workflow.start_hook.outcome': 'rejected',
      'workflow.start_hook.conflicting_run_id': 'wrun_owner',
    });
    expect(spanAttributes).not.toHaveProperty('workflow.start_hook.error_code');
  });

  it('records a refusal that names no owner as a contract failure, not a rejection', async () => {
    eventsCreate.mockRejectedValue(new HookConflictError(TOKEN));
    admittingWorld();
    await rejection(start(workflow, [], { hook: { token: TOKEN } }));
    expect(spanAttributes).toMatchObject({
      'workflow.start_hook.outcome': 'failed',
      'workflow.start_hook.error_code': RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
    });
  });

  it('records an outcome on a capability throw before anything is written', async () => {
    admittingWorld({ capabilities: { inBandFence: true } });
    await rejection(start(workflow, [], { hook: { token: TOKEN } }));
    expect(spanAttributes).toMatchObject({
      'workflow.start_hook.outcome': 'failed',
      'workflow.start_hook.error_code': RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
    });
    expect(queue).not.toHaveBeenCalled();
  });

  it("records a permanent rejection's code and reason", async () => {
    eventsCreate.mockRejectedValue(
      new WorkflowWorldError('too old', {
        status: 400,
        code: START_HOOK_ADMISSION_REJECTED,
        reason: 'expired',
      })
    );
    admittingWorld();
    await rejection(start(workflow, [], { hook: { token: TOKEN } }));
    expect(spanAttributes).toMatchObject({
      'workflow.start_hook.outcome': 'failed',
      'workflow.start_hook.error_code': START_HOOK_ADMISSION_REJECTED,
      'workflow.start_hook.rejection_reason': 'expired',
      // Set when it was minted, so a start that failed still names it.
      'workflow.run.id': expect.stringMatching(/^wrun_/),
    });
  });

  it('records an unconfirmed admission as uncertain and warns with its run and stage', async () => {
    const warn = vi.spyOn(runtimeLogger, 'warn');
    eventsCreate.mockRejectedValue(
      new WorkflowWorldError('switched off', {
        status: 400,
        code: START_HOOK_ADMISSION_DISABLED,
        reason: 'disabled',
      })
    );
    admittingWorld();
    const error = await rejection(
      start(workflow, [], { hook: { token: TOKEN } })
    );
    expect(WorkflowStartError.is(error)).toBe(true);
    expect(spanAttributes).toMatchObject({
      'workflow.start_hook.outcome': 'uncertain',
      'workflow.start_hook.error_code': 'WorkflowStartError:admission',
      'workflow.start_hook.rejection_reason': 'disabled',
      'workflow.start_hook.confirm_attempts':
        START_HOOK_CONFIRM_DELAYS_MS.length,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not confirm its candidate'),
      expect.objectContaining({
        workflowRunId: (error as WorkflowStartError).runId,
        stage: 'admission',
        reason: 'disabled',
      })
    );
  });
});

describe('the invocation span of a queued copy', () => {
  const runInput = { startHook: { token: TOKEN } } as any;

  it('records a refusal with its owner and trigger', () => {
    const span = fakeSpan();
    expect(
      ackRefusedStartHookCandidate(
        new HookConflictError(TOKEN, 'wrun_owner'),
        runInput,
        'wrun_candidate',
        span
      )
    ).toBe(true);
    expect(spanAttributes).toEqual({
      'workflow.start_hook': true,
      'workflow.start_hook.outcome': 'rejected',
      'workflow.start_hook.trigger': 'run_started',
      'workflow.start_hook.conflicting_run_id': 'wrun_owner',
    });
  });

  it('records a permanent rejection with its reason, and logs a kill-switch refusal at warn', () => {
    const warn = vi.spyOn(runtimeLogger, 'warn');
    const error = vi.spyOn(runtimeLogger, 'error');
    expect(
      ackRefusedStartHookCandidate(
        new WorkflowWorldError('off', {
          status: 400,
          code: START_HOOK_ADMISSION_REJECTED,
          reason: 'disabled',
        }),
        runInput,
        'wrun_candidate',
        fakeSpan()
      )
    ).toBe(true);
    expect(spanAttributes).toMatchObject({
      'workflow.start_hook.outcome': 'failed',
      'workflow.start_hook.trigger': 'run_started',
      'workflow.start_hook.error_code': START_HOOK_ADMISSION_REJECTED,
      'workflow.start_hook.rejection_reason': 'disabled',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('permanently rejected'),
      expect.objectContaining({ reason: 'disabled' })
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('records the write that admits, and nothing for an ordinary run', () => {
    recordAcceptedStartHookCandidate(
      undefined,
      { runId: 'wrun_x' },
      fakeSpan()
    );
    expect(spanAttributes).toEqual({});
    recordAcceptedStartHookCandidate(
      runInput,
      { runId: 'wrun_x', startHook: { token: runInput.startHook!.token } },
      fakeSpan()
    );
    expect(spanAttributes).toEqual({
      'workflow.start_hook': true,
      'workflow.start_hook.outcome': 'accepted',
      'workflow.start_hook.trigger': 'run_started',
    });
  });

  it('refuses a run_started whose run does not echo the start Hook token', () => {
    const thrown = (() => {
      try {
        recordAcceptedStartHookCandidate(
          runInput,
          { runId: 'wrun_x' },
          fakeSpan()
        );
      } catch (error) {
        return error;
      }
    })();
    expect(WorkflowWorldError.is(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      code: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
    });
    expect(spanAttributes).toMatchObject({
      'workflow.start_hook.outcome': 'failed',
    });
  });
});

describe('the holder wake', () => {
  const holder = (status: string, ageMs: number) => ({
    runId: 'wrun_holder',
    status,
    createdAt: new Date(Date.now() - ageMs),
    workflowName: 'workflow//./test//orders',
    deploymentId: 'deploy_123',
    executionContext: {},
  });
  const worldWith = (get: ReturnType<typeof vi.fn>) =>
    ({ runs: { get }, queue: vi.fn().mockResolvedValue(undefined) }) as any;

  it.each([
    [
      'woken',
      vi
        .fn()
        .mockResolvedValue(
          holder('pending', START_HOOK_HOLDER_WAKE_AFTER_MS + 1)
        ),
    ],
    ['not_pending', vi.fn().mockResolvedValue(holder('running', 0))],
    ['too_young', vi.fn().mockResolvedValue(holder('pending', 0))],
    [
      'not_found',
      vi.fn().mockRejectedValue(new WorkflowRunNotFoundError('wrun_holder')),
    ],
    ['error', vi.fn().mockRejectedValue(new Error('network'))],
  ])('says %s, and logs why', async (reason, get) => {
    const logs = [
      vi.spyOn(runtimeLogger, 'debug'),
      vi.spyOn(runtimeLogger, 'info'),
      vi.spyOn(runtimeLogger, 'warn'),
    ];
    expect(
      await wakePendingStartHookHolder(worldWith(get), 'wrun_holder', {})
    ).toBe(reason);
    expect(logs.flatMap((log) => log.mock.calls)).toContainEqual([
      expect.any(String),
      expect.objectContaining({ workflowRunId: 'wrun_holder', reason }),
    ]);
  });
});
