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

    await listAttributes(worldWith(list), {
      json: true,
      workflowName: 'orderWorkflow',
      since: '7d',
      cursor: 'first',
      limit: 25,
    });

    const params = list.mock.calls[0][0];
    expect(params.workflowName).toBe('orderWorkflow');
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
