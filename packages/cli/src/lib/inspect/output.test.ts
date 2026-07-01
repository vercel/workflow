import type {
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
import {
  getObservabilityUpgradeRequiredMessage,
  isObservabilityUpgradeRequiredError,
} from './errors.js';
import {
  formatTableValue,
  hasExpiredData,
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
