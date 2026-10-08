import type {
  AnalyticsAttributeKey,
  AnalyticsEvent,
  AnalyticsRun,
  AnalyticsStep,
  AnalyticsWait,
  Event,
  Step,
  WorkflowRun,
  World,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../config/log.js';
import {
  getObservabilityUpgradeRequiredMessage,
  isObservabilityUpgradeRequiredError,
} from './errors.js';
import {
  formatTableValue,
  hasExpiredData,
  listAttributes,
  listEvents,
  listRuns,
  listSleeps,
  listSteps,
  listStreamsByRunId,
  showEvent,
  showStep,
} from './output.js';

const makeRun = (overrides: Partial<WorkflowRun> = {}): WorkflowRun =>
  ({
    runId: 'run-1',
    status: 'running',
    deploymentId: 'dep-1',
    workflowName: 'workflow//./src/workflows/test//myWorkflow',
    input: undefined,
    output: undefined,
    error: undefined,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    completedAt: undefined,
    startedAt: undefined,
    expiredAt: undefined,
    specVersion: 2,
    executionContext: {},
    ...overrides,
  }) as unknown as WorkflowRun;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hasExpiredData', () => {
  it('returns false when expiredAt is undefined', () => {
    expect(hasExpiredData(makeRun({ expiredAt: undefined }))).toBe(false);
  });

  it('returns false when expiredAt is in the future', () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(hasExpiredData(makeRun({ expiredAt: future }))).toBe(false);
  });

  it('returns true when expiredAt is in the past', () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(hasExpiredData(makeRun({ expiredAt: past }))).toBe(true);
  });
});

describe('formatTableValue expired data handling', () => {
  it('returns input value when expiredAt is in the future', () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const item = { expiredAt: future.toISOString(), input: 'hello' };
    const result = formatTableValue('input', 'hello', {}, undefined, item);
    expect(result).not.toContain('expired');
  });

  it('returns expired message when expiredAt is in the past', () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const item = { expiredAt: past.toISOString(), output: 'hello' };
    const result = formatTableValue('output', 'hello', {}, undefined, item);
    expect(String(result)).toContain('data expired');
  });

  it('returns input value when expiredAt is not present', () => {
    const item = { input: 'hello' };
    const result = formatTableValue('input', 'hello', {}, undefined, item);
    expect(String(result)).not.toContain('expired');
  });
});

describe('isObservabilityUpgradeRequiredError', () => {
  it('detects workflow analytics 402 errors by top-level code', () => {
    expect(
      isObservabilityUpgradeRequiredError({
        status: 402,
        code: 'observability-upgrade-required',
      })
    ).toBe(true);
  });

  it('detects workflow analytics 402 errors by response body error', () => {
    expect(
      isObservabilityUpgradeRequiredError({
        status: 402,
        body: { error: 'observability-upgrade-required' },
      })
    ).toBe(true);
  });

  it('does not treat 404s as upgrade prompts', () => {
    expect(
      isObservabilityUpgradeRequiredError({
        status: 404,
        code: 'observability-upgrade-required',
      })
    ).toBe(false);
  });

  it('uses an upgrade prompt message', () => {
    expect(getObservabilityUpgradeRequiredMessage()).toContain(
      'Upgrade Observability Plus'
    );
  });
});

describe('listRuns', () => {
  it('preserves analytics page metadata in JSON output', async () => {
    const run = {
      runId: 'run-1',
      status: 'running',
      deploymentId: 'dep-1',
      workflowName: 'workflow//./src/workflows/test//myWorkflow',
      specVersion: 2,
      attributes: {},
      createdAt: new Date('2026-06-30T00:00:00.000Z'),
      updatedAt: new Date('2026-06-30T00:00:00.000Z'),
      startedAt: new Date('2026-06-30T00:00:01.000Z'),
      completedAt: null,
      errorCode: null,
      workflowCoreVersion: null,
      workflowEncryptionEnabled: false,
    } satisfies AnalyticsRun;
    const pageInfo = {
      currentLookbackDays: 2,
      maxLookbackDays: 30,
      currentWindowStart: new Date('2026-06-28T00:00:00.000Z'),
      maxWindowStart: new Date('2026-06-01T00:00:00.000Z'),
      upgradeAvailable: true,
    };
    const world = {
      analytics: {
        runs: {
          list: vi.fn().mockResolvedValue({
            data: [run],
            cursor: null,
            hasMore: false,
            pageInfo,
          }),
        },
      },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await listRuns(world, { json: true });

    expect(world.analytics?.runs.list).toHaveBeenCalledWith({
      workflowName: undefined,
      status: undefined,
      pagination: {
        sortOrder: 'desc',
        cursor: undefined,
        limit: 20,
      },
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual({
      data: [
        {
          ...run,
          createdAt: '2026-06-30T00:00:00.000Z',
          updatedAt: '2026-06-30T00:00:00.000Z',
          startedAt: '2026-06-30T00:00:01.000Z',
        },
      ],
      cursor: null,
      hasMore: false,
      pageInfo: {
        currentLookbackDays: 2,
        maxLookbackDays: 30,
        currentWindowStart: '2026-06-28T00:00:00.000Z',
        maxWindowStart: '2026-06-01T00:00:00.000Z',
        upgradeAvailable: true,
      },
    });
  });

  it('includes world-specific fields when the world defines describeRun', async () => {
    const run = {
      runId: 'wrun_41KX206BTK10M0C31CMN2AS1JS',
      status: 'running',
      deploymentId: 'dep-1',
      workflowName: 'workflow//./src/workflows/test//myWorkflow',
      specVersion: 2,
      attributes: {},
      createdAt: new Date('2026-06-30T00:00:00.000Z'),
      updatedAt: new Date('2026-06-30T00:00:00.000Z'),
      startedAt: new Date('2026-06-30T00:00:01.000Z'),
      completedAt: null,
      errorCode: null,
      workflowCoreVersion: null,
      workflowEncryptionEnabled: false,
    } satisfies AnalyticsRun;
    const describeRun = vi.fn().mockReturnValue({ region: 'sfo1', shard: 'a' });
    const world = {
      describeRun,
      analytics: {
        runs: {
          list: vi.fn().mockResolvedValue({
            data: [run],
            cursor: null,
            hasMore: false,
          }),
        },
      },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await listRuns(world, { json: true });

    expect(describeRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: run.runId })
    );
    const output = JSON.parse(String(write.mock.calls[0][0]));
    expect(output.data[0].region).toBe('sfo1');
    expect(output.data[0].shard).toBe('a');
  });

  it('preserves null field values from describeRun in JSON output', async () => {
    // null means "applicable but undeterminable" — distinguishable from
    // the hook being absent (key missing entirely).
    const run = {
      runId: 'wrun_malformed',
      status: 'running',
      deploymentId: 'dep-1',
      workflowName: 'workflow//./src/workflows/test//myWorkflow',
      specVersion: 2,
      attributes: {},
      createdAt: new Date('2026-06-30T00:00:00.000Z'),
      updatedAt: new Date('2026-06-30T00:00:00.000Z'),
      startedAt: new Date('2026-06-30T00:00:01.000Z'),
      completedAt: null,
      errorCode: null,
      workflowCoreVersion: null,
      workflowEncryptionEnabled: false,
    } satisfies AnalyticsRun;
    const world = {
      describeRun: vi.fn().mockReturnValue({ region: null }),
      analytics: {
        runs: {
          list: vi.fn().mockResolvedValue({
            data: [run],
            cursor: null,
            hasMore: false,
          }),
        },
      },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await listRuns(world, { json: true });

    const output = JSON.parse(String(write.mock.calls[0][0]));
    expect('region' in output.data[0]).toBe(true);
    expect(output.data[0].region).toBeNull();
  });

  it('never lets describeRun overwrite canonical run fields', async () => {
    const run = {
      runId: 'wrun_41KX206BTK10M0C31CMN2AS1JS',
      status: 'running',
      deploymentId: 'dep-1',
      workflowName: 'workflow//./src/workflows/test//myWorkflow',
      specVersion: 2,
      attributes: {},
      createdAt: new Date('2026-06-30T00:00:00.000Z'),
      updatedAt: new Date('2026-06-30T00:00:00.000Z'),
      startedAt: new Date('2026-06-30T00:00:01.000Z'),
      completedAt: null,
      errorCode: null,
      workflowCoreVersion: null,
      workflowEncryptionEnabled: false,
    } satisfies AnalyticsRun;
    const world = {
      // Hostile/buggy world: tries to clobber canonical fields.
      describeRun: vi
        .fn()
        .mockReturnValue({ status: 'hacked', runId: 'nope', region: 'sfo1' }),
      analytics: {
        runs: {
          list: vi.fn().mockResolvedValue({
            data: [run],
            cursor: null,
            hasMore: false,
          }),
        },
      },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await listRuns(world, { json: true });

    const output = JSON.parse(String(write.mock.calls[0][0]));
    expect(output.data[0].status).toBe('running');
    expect(output.data[0].runId).toBe(run.runId);
    expect(output.data[0].region).toBe('sfo1');
  });

  it('treats a throwing describeRun as contributing no fields', async () => {
    const run = {
      runId: 'wrun_41KX206BTK10M0C31CMN2AS1JS',
      status: 'running',
      deploymentId: 'dep-1',
      workflowName: 'workflow//./src/workflows/test//myWorkflow',
      specVersion: 2,
      attributes: {},
      createdAt: new Date('2026-06-30T00:00:00.000Z'),
      updatedAt: new Date('2026-06-30T00:00:00.000Z'),
      startedAt: new Date('2026-06-30T00:00:01.000Z'),
      completedAt: null,
      errorCode: null,
      workflowCoreVersion: null,
      workflowEncryptionEnabled: false,
    } satisfies AnalyticsRun;
    const world = {
      describeRun: vi.fn().mockImplementation(() => {
        throw new Error('buggy world');
      }),
      analytics: {
        runs: {
          list: vi.fn().mockResolvedValue({
            data: [run],
            cursor: null,
            hasMore: false,
          }),
        },
      },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    // Must not throw despite the world violating the no-throw contract.
    await listRuns(world, { json: true });

    const output = JSON.parse(String(write.mock.calls[0][0]));
    expect(output.data[0].status).toBe('running');
    expect('region' in output.data[0]).toBe(false);
  });

  it('supports async describeRun implementations', async () => {
    const run = {
      runId: 'wrun_41KX206BTK10M0C31CMN2AS1JS',
      status: 'running',
      deploymentId: 'dep-1',
      workflowName: 'workflow//./src/workflows/test//myWorkflow',
      specVersion: 2,
      attributes: {},
      createdAt: new Date('2026-06-30T00:00:00.000Z'),
      updatedAt: new Date('2026-06-30T00:00:00.000Z'),
      startedAt: new Date('2026-06-30T00:00:01.000Z'),
      completedAt: null,
      errorCode: null,
      workflowCoreVersion: null,
      workflowEncryptionEnabled: false,
    } satisfies AnalyticsRun;
    const world = {
      describeRun: vi.fn().mockResolvedValue({ region: 'sfo1' }),
      analytics: {
        runs: {
          list: vi.fn().mockResolvedValue({
            data: [run],
            cursor: null,
            hasMore: false,
          }),
        },
      },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await listRuns(world, { json: true });

    const output = JSON.parse(String(write.mock.calls[0][0]));
    expect(output.data[0].region).toBe('sfo1');
  });

  it('treats a rejecting async describeRun as contributing no fields', async () => {
    const run = {
      runId: 'wrun_41KX206BTK10M0C31CMN2AS1JS',
      status: 'running',
      deploymentId: 'dep-1',
      workflowName: 'workflow//./src/workflows/test//myWorkflow',
      specVersion: 2,
      attributes: {},
      createdAt: new Date('2026-06-30T00:00:00.000Z'),
      updatedAt: new Date('2026-06-30T00:00:00.000Z'),
      startedAt: new Date('2026-06-30T00:00:01.000Z'),
      completedAt: null,
      errorCode: null,
      workflowCoreVersion: null,
      workflowEncryptionEnabled: false,
    } satisfies AnalyticsRun;
    const world = {
      describeRun: vi.fn().mockRejectedValue(new Error('async buggy world')),
      analytics: {
        runs: {
          list: vi.fn().mockResolvedValue({
            data: [run],
            cursor: null,
            hasMore: false,
          }),
        },
      },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await listRuns(world, { json: true });

    const output = JSON.parse(String(write.mock.calls[0][0]));
    expect(output.data[0].status).toBe('running');
    expect('region' in output.data[0]).toBe(false);
  });

  it('adds no world fields when the world lacks describeRun', async () => {
    const run = {
      runId: 'wrun_01KX2M5N3RBNC12RYWYYH4WWQJ',
      status: 'running',
      deploymentId: 'dep-1',
      workflowName: 'workflow//./src/workflows/test//myWorkflow',
      specVersion: 2,
      attributes: {},
      createdAt: new Date('2026-06-30T00:00:00.000Z'),
      updatedAt: new Date('2026-06-30T00:00:00.000Z'),
      startedAt: new Date('2026-06-30T00:00:01.000Z'),
      completedAt: null,
      errorCode: null,
      workflowCoreVersion: null,
      workflowEncryptionEnabled: false,
    } satisfies AnalyticsRun;
    const world = {
      analytics: {
        runs: {
          list: vi.fn().mockResolvedValue({
            data: [run],
            cursor: null,
            hasMore: false,
          }),
        },
      },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await listRuns(world, { json: true });

    const output = JSON.parse(String(write.mock.calls[0][0]));
    expect('region' in output.data[0]).toBe(false);
  });
});

describe('listSteps', () => {
  it('passes cursors and preserves the JSON array output', async () => {
    const step = {
      runId: 'run-1',
      stepId: 'step-1',
      stepName: 'doWork',
      status: 'completed',
      attempt: 1,
      createdAt: new Date('2026-06-30T00:00:00.000Z'),
      updatedAt: new Date('2026-06-30T00:00:02.000Z'),
      startedAt: new Date('2026-06-30T00:00:01.000Z'),
      completedAt: new Date('2026-06-30T00:00:02.000Z'),
      retryAfter: null,
      errorCode: null,
      workflowCoreVersion: null,
      workflowEncryptionEnabled: false,
    } satisfies AnalyticsStep;
    const world = {
      analytics: {
        steps: {
          list: vi.fn().mockResolvedValue({
            data: [step],
            cursor: 'next-step-cursor',
            hasMore: true,
          }),
        },
      },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await listSteps(world, {
      json: true,
      runId: 'run-1',
      cursor: 'step-cursor',
      limit: 1,
    });

    expect(world.analytics?.steps.list).toHaveBeenCalledWith({
      runId: 'run-1',
      pagination: {
        sortOrder: 'desc',
        cursor: 'step-cursor',
        limit: 1,
      },
    });
    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual([
      {
        ...step,
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:02.000Z',
        startedAt: '2026-06-30T00:00:01.000Z',
        completedAt: '2026-06-30T00:00:02.000Z',
      },
    ]);
  });

  it('falls back to storage when the first analytics page is empty', async () => {
    const step = {
      runId: 'run-1',
      stepId: 'step-1',
      stepName: 'step//./src/workflows/test//doWork',
      status: 'completed',
      attempt: 1,
      input: undefined,
      output: undefined,
      createdAt: new Date('2026-06-30T00:00:00.000Z'),
      updatedAt: new Date('2026-06-30T00:00:02.000Z'),
      startedAt: new Date('2026-06-30T00:00:01.000Z'),
      completedAt: new Date('2026-06-30T00:00:02.000Z'),
    } satisfies Step;
    const world = {
      analytics: {
        steps: {
          list: vi.fn().mockResolvedValue({
            data: [],
            cursor: null,
            hasMore: false,
          }),
        },
      },
      steps: {
        list: vi.fn().mockResolvedValue({
          data: [step],
          cursor: null,
          hasMore: false,
        }),
      },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await listSteps(world, { json: true, runId: 'run-1' });

    expect(world.analytics?.steps.list).toHaveBeenCalled();
    expect(world.steps.list).toHaveBeenCalledWith({
      runId: 'run-1',
      pagination: {
        sortOrder: 'desc',
        cursor: undefined,
        limit: 20,
      },
      resolveData: 'none',
    });
    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual([
      {
        ...step,
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:02.000Z',
        startedAt: '2026-06-30T00:00:01.000Z',
        completedAt: '2026-06-30T00:00:02.000Z',
      },
    ]);
  });
});

describe('listEvents', () => {
  it('passes cursors and preserves the JSON array output', async () => {
    const event = {
      runId: 'run-1',
      eventId: 'event-1',
      eventType: 'step_completed',
      correlationId: 'step-1',
      entityId: 'step-1',
      stepName: 'doWork',
      workflowName: 'workflow//./src/workflows/test//myWorkflow',
      deploymentId: 'dep-1',
      specVersion: 2,
      runCreatedAt: new Date('2026-06-30T00:00:00.000Z'),
      createdAt: new Date('2026-06-30T00:00:02.000Z'),
      region: null,
      vercelId: null,
      requestId: null,
      resumeAt: null,
      retryAfter: null,
      errorCode: null,
      workflowCoreVersion: null,
      isWebhook: false,
      isSystem: false,
      workflowEncryptionEnabled: false,
    } satisfies AnalyticsEvent;
    const world = {
      analytics: {
        events: {
          list: vi.fn().mockResolvedValue({
            data: [event],
            cursor: 'next-event-cursor',
            hasMore: true,
          }),
        },
      },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await listEvents(world, {
      json: true,
      runId: 'run-1',
      cursor: 'event-cursor',
      limit: 1,
    });

    expect(world.analytics?.events.list).toHaveBeenCalledWith({
      runId: 'run-1',
      correlationId: undefined,
      pagination: {
        sortOrder: 'desc',
        cursor: 'event-cursor',
        limit: 1,
      },
    });
    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual([
      {
        ...event,
        runCreatedAt: '2026-06-30T00:00:00.000Z',
        createdAt: '2026-06-30T00:00:02.000Z',
      },
    ]);
  });

  it('falls back to storage when the first analytics page is empty', async () => {
    const event = {
      runId: 'run-1',
      eventId: 'event-1',
      eventType: 'step_completed',
      correlationId: 'step-1',
      eventData: {
        stepName: 'doWork',
        result: undefined,
      },
      createdAt: new Date('2026-06-30T00:00:02.000Z'),
    } as unknown as Event;
    const world = {
      analytics: {
        events: {
          list: vi.fn().mockResolvedValue({
            data: [],
            cursor: null,
            hasMore: false,
          }),
        },
      },
      events: {
        list: vi.fn().mockResolvedValue({
          data: [event],
          cursor: null,
          hasMore: false,
        }),
      },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await listEvents(world, { json: true, runId: 'run-1' });

    expect(world.analytics?.events.list).toHaveBeenCalled();
    expect(world.events.list).toHaveBeenCalledWith({
      runId: 'run-1',
      pagination: {
        sortOrder: 'desc',
        cursor: undefined,
        limit: 20,
      },
      resolveData: 'none',
    });
    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual([
      {
        ...event,
        createdAt: '2026-06-30T00:00:02.000Z',
      },
    ]);
  });
});

describe('listSleeps', () => {
  const wait = {
    runId: 'run-1',
    waitId: 'wait-1',
    status: 'waiting',
    resumeAt: new Date('2026-06-30T00:01:00.000Z'),
    createdAt: new Date('2026-06-30T00:00:00.000Z'),
    updatedAt: new Date('2026-06-30T00:00:00.000Z'),
    completedAt: null,
    workflowCoreVersion: null,
    workflowEncryptionEnabled: false,
  } satisfies AnalyticsWait;
  const pageInfo = {
    currentLookbackDays: 2,
    maxLookbackDays: 30,
    currentWindowStart: new Date('2026-06-28T00:00:00.000Z'),
    maxWindowStart: new Date('2026-06-01T00:00:00.000Z'),
    upgradeAvailable: true,
  };

  it('passes cursors and preserves the JSON array output through analytics', async () => {
    const world = {
      analytics: {
        waits: {
          list: vi.fn().mockResolvedValue({
            data: [wait],
            cursor: 'next-wait-cursor',
            hasMore: true,
            pageInfo,
          }),
        },
      },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await listSleeps(world, {
      json: true,
      runId: 'run-1',
      cursor: 'wait-cursor',
      limit: 1,
    });

    expect(world.analytics?.waits.list).toHaveBeenCalledWith({
      runId: 'run-1',
      pagination: {
        sortOrder: 'desc',
        cursor: 'wait-cursor',
        limit: 1,
      },
    });
    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual([
      {
        ...wait,
        resumeAt: '2026-06-30T00:01:00.000Z',
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z',
      },
    ]);
  });

  it('surfaces the observability upgrade hint in table mode', async () => {
    const world = {
      analytics: {
        waits: {
          list: vi.fn().mockResolvedValue({
            data: [wait],
            cursor: null,
            hasMore: false,
            pageInfo,
          }),
        },
      },
    } as unknown as World;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await listSleeps(world, { runId: 'run-1' });

    expect(log.mock.calls.flat().join('\n')).toContain(
      'Upgrade Observability Plus'
    );
  });
});

describe('listSleeps analytics degradation', () => {
  const eventBase = {
    runId: 'run-1',
    workflowName: 'wf',
    deploymentId: 'dpl_1',
  };

  // The other three list paths fall back to storage; this one used to end the
  // command, leaving its storage branch unreachable wherever analytics exists.
  it('falls back to the event log when the analytics read fails', async () => {
    const world = {
      analytics: {
        waits: {
          list: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('upstream unavailable'), { status: 503 })
            ),
        },
      },
      events: {
        list: vi.fn().mockResolvedValue({
          data: [
            {
              ...eventBase,
              eventId: 'evnt-1',
              eventType: 'wait_created',
              correlationId: 'wait-1',
              createdAt: new Date('2026-06-30T00:00:00.000Z'),
              eventData: { resumeAt: new Date('2026-06-30T00:01:00.000Z') },
            },
          ],
          cursor: null,
          hasMore: false,
        }),
      },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await listSleeps(world, { json: true, runId: 'run-1' });

    expect(world.analytics?.waits.list).toHaveBeenCalled();
    expect(world.events.list).toHaveBeenCalled();
    expect(write.mock.calls.join('')).toContain('wait-1');
    write.mockRestore();
  });

  // Retrying an argument the World already rejected would only replace a
  // precise message with a slower failure.
  it('does not fall back when the argument was rejected', async () => {
    const world = {
      analytics: {
        waits: {
          list: vi
            .fn()
            .mockRejectedValue(
              Object.assign(
                new Error(
                  'analytics.waits.list: runId must be a workflow run id'
                ),
                { code: 'INVALID_ARGUMENT', field: 'runId' }
              )
            ),
        },
      },
      events: { list: vi.fn() },
    } as unknown as World;

    await listSleeps(world, { runId: 'nope' });

    expect(world.analytics?.waits.list).toHaveBeenCalled();
    expect(world.events.list).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

describe('listAttributes', () => {
  const key = {
    key: 'application',
    runCount: 12,
    firstSeenAt: new Date('2026-08-26T09:14:02.000Z'),
    lastSeenAt: new Date('2026-09-02T21:40:11.000Z'),
  } satisfies AnalyticsAttributeKey;

  const worldWith = (list: ReturnType<typeof vi.fn>) =>
    ({ analytics: { attributes: { list } } }) as unknown as World;

  it('passes the window, name filter and cursor, and preserves JSON output', async () => {
    const list = vi.fn().mockResolvedValue({
      data: [key],
      cursor: 'next',
      hasMore: true,
    });
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    // A full name: a short one is resolved against recent runs first, which
    // workflow-name.test.ts covers.
    const workflowName = 'workflow//./src/workflows/order//orderWorkflow';
    await listAttributes(worldWith(list), {
      json: true,
      workflowName,
      since: '7d',
      cursor: 'first',
      limit: 25,
    });

    const params = list.mock.calls[0][0];
    expect(params.workflowName).toBe(workflowName);
    expect(params.startTime).toBeDefined();
    expect(params.endTime).toBeDefined();
    expect(params.pagination).toMatchObject({ cursor: 'first', limit: 25 });
    expect(write.mock.calls.join('')).toContain('application');
    write.mockRestore();
  });

  // The backend orders keys alphabetically; forwarding a defaulted `desc`
  // would override that, so the flag is only sent when it was passed.
  it('omits sortOrder unless --sort was given', async () => {
    const list = vi
      .fn()
      .mockResolvedValue({ data: [], cursor: null, hasMore: false });

    await listAttributes(worldWith(list), { json: true });
    expect(list.mock.calls[0][0].pagination.sortOrder).toBeUndefined();

    await listAttributes(worldWith(list), { json: true, sort: 'asc' });
    expect(list.mock.calls[1][0].pagination.sortOrder).toBe('asc');
  });

  // Analytics-only: there is no cross-run attribute index in storage.
  it('reports that the backend cannot list attributes', async () => {
    const world = { analytics: undefined } as unknown as World;
    await listAttributes(world, { json: true });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  // Every one of these parsed, was dropped, and left the full key table
  // looking like a filtered answer. The sibling listings warn on the
  // selectors they cannot apply; this one warned on nothing.
  describe.each([
    ['status', { status: 'failed' as const }, 'Filtering by status'],
    ['runId', { runId: 'wrun_x' }, 'Filtering by run-id'],
    ['stepId', { stepId: 'step_x' }, 'Filtering by step-id'],
    ['hookId', { hookId: 'hook_x' }, 'Filtering by hook-id'],
    ['withData', { withData: true }, '`withData` flag is ignored'],
  ])('with --%s', (_flag, opts, expected) => {
    it('warns that the filter does not apply', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const list = vi
        .fn()
        .mockResolvedValue({ data: [key], cursor: null, hasMore: false });

      await listAttributes(worldWith(list), { json: true, ...opts });

      expect(warn.mock.calls.flat().join(' ')).toContain(expected);
      warn.mockRestore();
    });

    // The listing takes a workflow name and a window; nothing here reaches
    // the backend, so warning is the only signal the caller gets.
    it('forwards none of it to the backend', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const list = vi
        .fn()
        .mockResolvedValue({ data: [key], cursor: null, hasMore: false });

      await listAttributes(worldWith(list), { json: true, ...opts });

      const params = list.mock.calls[0][0];
      expect(params.status).toBeUndefined();
      expect(params.runId).toBeUndefined();
      expect(params.stepId).toBeUndefined();
      expect(params.hookId).toBeUndefined();
      vi.restoreAllMocks();
    });
  });
});

describe('listRuns attribute filtering', () => {
  const run = {
    runId: 'run-1',
    status: 'completed',
    deploymentId: 'dep-1',
    workflowName: 'workflow//./src/workflows/test//myWorkflow',
    attributes: { tenant: 'acme' },
    createdAt: new Date('2026-06-30T00:00:00.000Z'),
    updatedAt: new Date('2026-06-30T00:00:01.000Z'),
    startedAt: null,
    completedAt: null,
    errorCode: null,
    workflowCoreVersion: null,
    workflowEncryptionEnabled: false,
  } satisfies AnalyticsRun;

  it('forwards the filter to the analytics listing', async () => {
    const list = vi
      .fn()
      .mockResolvedValue({ data: [run], cursor: null, hasMore: false });
    const world = {
      analytics: { runs: { list } },
    } as unknown as World;

    await listRuns(world, { json: true, attributes: { tenant: 'acme' } });

    expect(list.mock.calls[0][0].attributes).toEqual({ tenant: 'acme' });
  });

  it('omits the key entirely when no filter was given', async () => {
    const list = vi
      .fn()
      .mockResolvedValue({ data: [run], cursor: null, hasMore: false });
    const world = {
      analytics: { runs: { list } },
    } as unknown as World;

    await listRuns(world, { json: true });

    expect('attributes' in list.mock.calls[0][0]).toBe(false);
  });

  // The warning names whichever condition applies. `--withData` is now
  // rejected upstream by validateAttributeScope, so the reachable case here
  // is a backend with no analytics namespace.
  it('says the backend has no analytics read path', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const world = {
      analytics: undefined,
      runs: {
        list: vi
          .fn()
          .mockResolvedValue({ data: [], cursor: null, hasMore: false }),
      },
    } as unknown as World;

    await listRuns(world, { json: true, attributes: { tenant: 'acme' } });

    expect(warn.mock.calls.flat().join(' ')).toContain(
      '--attribute is ignored by this backend, which has no analytics read path'
    );
    warn.mockRestore();
  });

  it('blames --withData when that is what moved the read off analytics', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const world = {
      analytics: { runs: { list: vi.fn() } },
      runs: {
        list: vi
          .fn()
          .mockResolvedValue({ data: [], cursor: null, hasMore: false }),
      },
    } as unknown as World;

    await listRuns(world, {
      json: true,
      withData: true,
      attributes: { tenant: 'acme' },
    });

    expect(warn.mock.calls.flat().join(' ')).toContain(
      '--attribute is ignored with --withData'
    );
    warn.mockRestore();
  });
});

describe('paging the bare-array listings', () => {
  const stepAt = (n: number) =>
    ({
      runId: 'run-1',
      stepId: `step-${String(n).repeat(4)}`,
      stepName: 'doWork',
      status: 'completed',
    }) as unknown as AnalyticsStep;

  /** An analytics step listing serving `pages`, keyed by the cursor that reaches each. */
  const analyticsSteps = (
    pages: Record<string, { ids: number[]; cursor: string | null }>
  ) =>
    vi.fn(async ({ pagination }: { pagination: { cursor?: string } }) => {
      const page = pages[pagination.cursor ?? ''];
      if (!page) throw new Error(`unexpected cursor ${pagination.cursor}`);
      return {
        data: page.ids.map(stepAt),
        cursor: page.cursor,
        hasMore: page.cursor !== null,
      };
    });

  const captureStdout = () =>
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  it('prints every page of steps as one JSON array with --all', async () => {
    const list = analyticsSteps({
      '': { ids: [1, 2], cursor: 'c1' },
      c1: { ids: [3, 4], cursor: 'c2' },
      c2: { ids: [5], cursor: null },
    });
    const world = { analytics: { steps: { list } } } as unknown as World;
    const write = captureStdout();

    await listSteps(world, { json: true, runId: 'run-1', all: true, limit: 2 });

    expect(list.mock.calls.map(([p]) => p.pagination.cursor)).toEqual([
      undefined,
      'c1',
      'c2',
    ]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String(write.mock.calls[0][0])).map(
        (s: { stepId: string }) => s.stepId
      )
    ).toEqual([
      'step-1111',
      'step-2222',
      'step-3333',
      'step-4444',
      'step-5555',
    ]);
  });

  it('starts --all from --cursor', async () => {
    const list = analyticsSteps({
      c1: { ids: [3], cursor: 'c2' },
      c2: { ids: [4], cursor: null },
    });
    const world = { analytics: { steps: { list } } } as unknown as World;
    const write = captureStdout();

    await listSteps(world, {
      json: true,
      runId: 'run-1',
      all: true,
      cursor: 'c1',
    });

    expect(list.mock.calls[0][0].pagination.cursor).toBe('c1');
    expect(JSON.parse(String(write.mock.calls[0][0]))).toHaveLength(2);
  });

  // The array is a published shape (scripts iterate it), so the cursor goes
  // to stderr; until now JSON output dropped it, and a run past one page could
  // not be read in full.
  it('reports the next cursor on stderr when a JSON page has more rows', async () => {
    const list = analyticsSteps({ '': { ids: [1], cursor: 'next-page' } });
    const world = { analytics: { steps: { list } } } as unknown as World;
    const write = captureStdout();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await listSteps(world, { json: true, runId: 'run-1' });

    expect(Array.isArray(JSON.parse(String(write.mock.calls[0][0])))).toBe(
      true
    );
    expect(warn.mock.calls.flat().join(' ')).toContain(
      '--cursor next-page for the next page or --all for every page'
    );
  });

  it('prints no cursor hint for the last page', async () => {
    const list = analyticsSteps({ '': { ids: [1], cursor: null } });
    const world = { analytics: { steps: { list } } } as unknown as World;
    captureStdout();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await listSteps(world, { json: true, runId: 'run-1' });

    expect(warn.mock.calls.flat().join(' ')).not.toContain('More results');
  });

  it('names the cursor in the table hint', async () => {
    const list = analyticsSteps({ '': { ids: [1], cursor: 'next-page' } });
    const world = { analytics: { steps: { list } } } as unknown as World;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await listSteps(world, { runId: 'run-1' });

    expect(log.mock.calls.flat().join('\n')).toContain(
      '--cursor next-page for the next page, --all for every page, or --interactive (-i)'
    );
  });

  it('prints every page of steps as one table with --all', async () => {
    const list = analyticsSteps({
      '': { ids: [1], cursor: 'c1' },
      c1: { ids: [2], cursor: null },
    });
    const world = { analytics: { steps: { list } } } as unknown as World;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await listSteps(world, { runId: 'run-1', all: true });

    // Narrow terminals truncate ids to their last four characters.
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain(String(1).repeat(4));
    expect(output).toContain(String(2).repeat(4));
    expect(output).not.toContain('More results');
  });

  // Analytics lags storage for a fresh run. The first page fell back to
  // storage, and the second used to go to analytics with storage's cursor.
  it('reads every page from storage once the first page fell back to it', async () => {
    const event = (n: number) =>
      ({
        runId: 'run-1',
        eventId: `evnt-${n}`,
        eventType: 'step_completed',
        correlationId: 'step-1',
        createdAt: new Date('2026-06-30T00:00:02.000Z'),
      }) as unknown as Event;
    const analyticsList = vi.fn(
      async ({ pagination }: { pagination: { cursor?: string } }) =>
        pagination.cursor
          ? Promise.reject(new Error('analytics was sent a storage cursor'))
          : { data: [], cursor: null, hasMore: false }
    );
    const storagePages: Record<
      string,
      { data: Event[]; cursor: string | null }
    > = {
      '': { data: [event(1)], cursor: 'storage-1' },
      'storage-1': { data: [event(2)], cursor: null },
    };
    const storageList = vi.fn(
      async ({ pagination }: { pagination: { cursor?: string } }) => {
        const page = storagePages[pagination.cursor ?? ''];
        return { ...page, hasMore: page.cursor !== null };
      }
    );
    const world = {
      analytics: { events: { list: analyticsList } },
      events: { list: storageList },
    } as unknown as World;
    const write = captureStdout();

    await listEvents(world, { json: true, runId: 'run-1', all: true });

    expect(analyticsList).toHaveBeenCalledTimes(1);
    expect(storageList.mock.calls.map(([p]) => p.pagination.cursor)).toEqual([
      undefined,
      'storage-1',
    ]);
    expect(
      JSON.parse(String(write.mock.calls[0][0])).map(
        (e: { eventId: string }) => e.eventId
      )
    ).toEqual(['evnt-1', 'evnt-2']);
  });

  // `--cursor storage-1` on a new invocation would go to analytics, so the
  // hint must not offer it.
  it('does not offer a storage-fallback cursor for reuse', async () => {
    const world = {
      analytics: {
        events: {
          list: vi
            .fn()
            .mockResolvedValue({ data: [], cursor: null, hasMore: false }),
        },
      },
      events: {
        list: vi.fn().mockResolvedValue({
          data: [{ runId: 'run-1', eventId: 'evnt-1' }],
          cursor: 'storage-1',
          hasMore: true,
        }),
      },
    } as unknown as World;
    captureStdout();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await listEvents(world, { json: true, runId: 'run-1' });

    const hint = warn.mock.calls.flat().join(' ');
    expect(hint).toContain('--all for every page');
    expect(hint).not.toContain('storage-1');
  });

  it('pages sleeps through analytics with --all', async () => {
    const wait = (n: number) =>
      ({ runId: 'run-1', waitId: `wait-${n}` }) as unknown as AnalyticsWait;
    const list = vi.fn(
      async ({ pagination }: { pagination: { cursor?: string } }) =>
        pagination.cursor
          ? { data: [wait(2)], cursor: null, hasMore: false }
          : { data: [wait(1)], cursor: 'w1', hasMore: true }
    );
    const world = { analytics: { waits: { list } } } as unknown as World;
    const write = captureStdout();

    await listSleeps(world, { json: true, runId: 'run-1', all: true });

    expect(
      JSON.parse(String(write.mock.calls[0][0])).map(
        (w: { waitId: string }) => w.waitId
      )
    ).toEqual(['wait-1', 'wait-2']);
  });
});

describe('stream hints', () => {
  const RUN = 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE';

  // `inspect stream <id>` needs the run; the hint used to suggest the bare
  // form, which then failed with "--run is required".
  it('puts the listed run into the steps table hint', async () => {
    const world = {
      analytics: {
        steps: {
          list: vi.fn().mockResolvedValue({
            data: [{ runId: RUN, stepId: 'step-1', status: 'completed' }],
            cursor: null,
            hasMore: false,
          }),
        },
      },
    } as unknown as World;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await listSteps(world, { runId: RUN });

    expect(log.mock.calls.flat().join('\n')).toContain(
      `workflow inspect stream <stream-id> --runId=${RUN}`
    );
  });

  it('prints the hint, with the run, under a streams table', async () => {
    const world = {
      streams: { list: vi.fn().mockResolvedValue(['strm_a', 'strm_b']) },
    } as unknown as World;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await listStreamsByRunId(world, { runId: RUN });

    expect(log.mock.calls.flat().join('\n')).toContain(
      `workflow inspect stream <stream-id> --runId=${RUN}`
    );
  });

  it('keeps JSON stream listings free of hints', async () => {
    const world = {
      streams: { list: vi.fn().mockResolvedValue(['strm_a']) },
    } as unknown as World;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await listStreamsByRunId(world, { runId: RUN, json: true });

    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual([
      { runId: RUN, streamId: 'strm_a' },
    ]);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('showEvent', () => {
  const RUN = 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE';
  const EVENT = 'evnt_00000000000000000000000003';

  it('reads the event from its run and prints it as JSON', async () => {
    const event = {
      runId: RUN,
      eventId: EVENT,
      eventType: 'step_completed',
      correlationId: 'step_1',
      createdAt: new Date('2026-06-30T00:00:02.000Z'),
    };
    const world = {
      events: { get: vi.fn().mockResolvedValue(event) },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await showEvent(world, EVENT, { runId: RUN, json: true });

    expect(world.events.get).toHaveBeenCalledWith(RUN, EVENT, {
      resolveData: 'all',
    });
    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual({
      ...event,
      createdAt: '2026-06-30T00:00:02.000Z',
    });
  });

  it('reports a missing event and exits non-zero', async () => {
    const world = {
      events: {
        get: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('Event not found'), { status: 404 })
          ),
      },
    } as unknown as World;
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((
      code: number
    ) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(showEvent(world, EVENT, { runId: RUN })).rejects.toThrow(
      'exit 1'
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.flat().join(' ')).toContain('Event not found');
  });

  it('needs the run', async () => {
    const world = { events: { get: vi.fn() } } as unknown as World;
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    await showEvent(world, EVENT, {});

    expect(world.events.get).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  // The hint used to suggest `inspect event <id>`, which the command rejected.
  it('is what the events table hint suggests', async () => {
    const world = {
      analytics: {
        events: {
          list: vi.fn().mockResolvedValue({
            data: [{ runId: RUN, eventId: EVENT, eventType: 'run_created' }],
            cursor: null,
            hasMore: false,
          }),
        },
      },
    } as unknown as World;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await listEvents(world, { runId: RUN });

    expect(log.mock.calls.flat().join('\n')).toContain(
      `To view details for an event, use \`workflow inspect event <event-id> --runId=${RUN}\``
    );
  });
});

describe('listRuns with a short workflow name', () => {
  const FULL = 'workflow//./src/jobs/order//processOrder';

  // The table shows `processOrder`; the backend matches only the full
  // name, so `-n processOrder` listed nothing.
  it('filters by the full name the short one resolves to', async () => {
    const list = vi.fn(async (params: { workflowName?: string }) => ({
      data: params.workflowName
        ? []
        : [{ runId: 'wrun_1', workflowName: FULL, status: 'completed' }],
      cursor: null,
      hasMore: false,
    }));
    const world = { runs: { list } } as unknown as World;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    await listRuns(world, { json: true, workflowName: 'processOrder' });

    expect(list.mock.calls.at(-1)?.[0].workflowName).toBe(FULL);
  });

  it('sends a full name as given, with no extra request', async () => {
    const list = vi
      .fn()
      .mockResolvedValue({ data: [], cursor: null, hasMore: false });
    const world = { runs: { list } } as unknown as World;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await listRuns(world, { json: true, workflowName: FULL });

    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0].workflowName).toBe(FULL);
  });
});

describe('showStep', () => {
  const RUN = 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE';

  it('reads the step from the run it was given', async () => {
    const step = { runId: RUN, stepId: 'step_1', status: 'completed' };
    const world = {
      runs: { list: vi.fn() },
      steps: { get: vi.fn().mockResolvedValue(step) },
    } as unknown as World;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await showStep(world, 'step_1', { runId: RUN, json: true });

    expect(world.steps.get).toHaveBeenCalledWith(RUN, 'step_1', {
      resolveData: 'all',
    });
    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual(step);
  });

  // It used to look the step up in the most recent run, which is another
  // run's whenever this one is not the newest.
  it('never guesses the latest run', async () => {
    const world = {
      runs: { list: vi.fn() },
      steps: { get: vi.fn() },
    } as unknown as World;
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await showStep(world, 'step_1', {});

    expect(world.runs.list).not.toHaveBeenCalled();
    expect(world.steps.get).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('is what the steps table hint suggests', async () => {
    const world = {
      analytics: {
        steps: {
          list: vi.fn().mockResolvedValue({
            data: [{ runId: RUN, stepId: 'step_1', status: 'completed' }],
            cursor: null,
            hasMore: false,
          }),
        },
      },
    } as unknown as World;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await listSteps(world, { runId: RUN });

    expect(log.mock.calls.flat().join('\n')).toContain(
      `To view details for a step, use \`workflow inspect step <step-id> --runId=${RUN}\``
    );
  });
});
