import type { AnalyticsRun, World, WorkflowRun } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getObservabilityUpgradeRequiredMessage,
  isObservabilityUpgradeRequiredError,
} from './errors.js';
import { formatTableValue, hasExpiredData, listRuns } from './output.js';

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
