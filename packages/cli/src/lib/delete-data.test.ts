import { PassThrough, Readable } from 'node:stream';
import { ThrottleError } from '@workflow/errors';
import type {
  DeleteRunDataResult,
  DeleteRunsDataRequest,
  DeleteRunsDataResult,
  World,
} from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import {
  createPromptConfirm,
  DELETE_DATA_MAX_ATTEMPTS,
  DELETE_DATA_NO_TTY_MESSAGE,
  DELETE_DATA_UNSUPPORTED_MESSAGE,
  deleteDataFailureLines,
  formatDeleteDataSummary,
  performDeleteData,
  readRunIds,
} from './delete-data.js';

/** Collects logger output so assertions can inspect what the user saw. */
function makeLogger() {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    logger: {
      log: (m: string) => logs.push(m),
      warn: (m: string) => warns.push(m),
      error: (m: string) => errors.push(m),
    },
    logs,
    warns,
    errors,
  };
}

/** The World's answer for `results`, with its summary counted. */
function answer(results: DeleteRunDataResult[]): DeleteRunsDataResult {
  const count = (outcome: DeleteRunDataResult['outcome']) =>
    results.filter((r) => r.outcome === outcome).length;
  return {
    summary: {
      requested: results.length,
      deleted: count('deleted'),
      alreadyDeleted: count('already_deleted'),
      skipped: count('skipped'),
      notCreated: count('not_created'),
      notFound: count('not_found'),
      failed: count('failed'),
    },
    results,
  };
}

const deleted = (runId: string): DeleteRunDataResult => ({
  runId,
  outcome: 'deleted',
});
const retryableFailure = (runId: string): DeleteRunDataResult => ({
  runId,
  outcome: 'failed',
  code: 'internal_error',
  retryable: true,
});

const mixedResult = answer([
  deleted('wrun_a'),
  { runId: 'wrun_b', outcome: 'already_deleted' },
  {
    runId: 'wrun_c',
    outcome: 'skipped',
    reason: 'run_not_terminal',
    status: 'running',
  },
  { runId: 'wrun_d', outcome: 'not_found' },
  { runId: 'wrun_e', outcome: 'failed', code: 'forbidden', retryable: false },
]);

/** A World whose `deleteDataMany` is `impl`, attached only when given. */
function makeWorld(
  impl?: (request: DeleteRunsDataRequest) => Promise<DeleteRunsDataResult>
): World {
  return {
    runs: { ...(impl ? { deleteDataMany: impl } : {}) },
  } as unknown as World;
}

/** A World answering every run with `outcomeFor(runId)`. */
function worldAnswering(
  outcomeFor: (runId: string) => DeleteRunDataResult = deleted
) {
  const deleteDataMany = vi.fn(async ({ runIds }: DeleteRunsDataRequest) =>
    answer(runIds.map(outcomeFor))
  );
  return { world: makeWorld(deleteDataMany), deleteDataMany };
}

const noSleep = vi.fn(async (_ms: number) => {});

describe('formatDeleteDataSummary', () => {
  it('counts every outcome, with `not_created` runs as deleted', () => {
    expect(
      formatDeleteDataSummary({
        summary: { ...mixedResult.summary, notCreated: 1 },
        results: [],
      })
    ).toBe(
      [
        'Done:',
        '  2 deleted',
        '  1 already deleted',
        '  1 skipped (not finished)',
        '  1 not found',
        '  1 failed',
      ].join('\n')
    );
  });
});

describe('deleteDataFailureLines', () => {
  it('calls out skipped, missing, and failed runs only', () => {
    expect(deleteDataFailureLines(mixedResult)).toEqual([
      '  ✗ wrun_c: skipped, the run has not finished (running). Cancel it first to delete its data.',
      '  ✗ wrun_d: not found',
      '  ✗ wrun_e: failed (forbidden)',
    ]);
  });
});

describe('readRunIds', () => {
  it('splits on newlines and any whitespace, ignoring blank lines', async () => {
    await expect(
      readRunIds(Readable.from(['wrun_a\nwrun_b  wrun_c\r\n', '\n\twrun_d\n']))
    ).resolves.toEqual(['wrun_a', 'wrun_b', 'wrun_c', 'wrun_d']);
  });
});

describe('performDeleteData', () => {
  it('deletes the confirmed runs once, deduplicated, and exits 1 on a failure', async () => {
    const deleteDataMany = vi.fn().mockResolvedValue(mixedResult);
    const promptConfirm = vi.fn().mockResolvedValue(true);
    const { logger, logs, warns } = makeLogger();

    const outcome = await performDeleteData({
      world: makeWorld(deleteDataMany),
      runIds: ['wrun_a', 'wrun_b', 'wrun_c', 'wrun_d', 'wrun_e', 'wrun_a'],
      confirm: false,
      logger,
      promptConfirm,
      sleep: noSleep,
    });

    expect(promptConfirm).toHaveBeenCalledWith(
      'Permanently delete the data of 5 runs? This cannot be undone.'
    );
    expect(deleteDataMany).toHaveBeenCalledTimes(1);
    expect(deleteDataMany).toHaveBeenCalledWith({
      runIds: ['wrun_a', 'wrun_b', 'wrun_c', 'wrun_d', 'wrun_e'],
    });
    expect(warns).toHaveLength(3);
    expect(logs.at(-1)).toContain('Done:');
    expect(outcome).toEqual({ exitCode: 1, result: mixedResult });
  });

  it('exits 0 when nothing failed, even if runs were skipped or missing', async () => {
    const { world } = worldAnswering((runId) =>
      runId === 'wrun_a'
        ? {
            runId,
            outcome: 'skipped',
            reason: 'run_not_terminal',
            status: 'pending',
          }
        : { runId, outcome: 'not_found' }
    );

    const outcome = await performDeleteData({
      world,
      runIds: ['wrun_a', 'wrun_b'],
      confirm: true,
      logger: makeLogger().logger,
    });

    expect(outcome.exitCode).toBe(0);
  });

  it('exits 1 with --strict when a run was not found or has not finished', async () => {
    for (const outcomeFor of [
      (runId: string): DeleteRunDataResult => ({ runId, outcome: 'not_found' }),
      (runId: string): DeleteRunDataResult => ({
        runId,
        outcome: 'skipped',
        reason: 'run_not_terminal',
        status: 'running',
      }),
    ]) {
      const { world } = worldAnswering(outcomeFor);
      const outcome = await performDeleteData({
        world,
        runIds: ['wrun_a'],
        confirm: true,
        strict: true,
        logger: makeLogger().logger,
      });
      expect(outcome.exitCode).toBe(1);
    }

    const { world } = worldAnswering((runId) =>
      runId === 'wrun_a'
        ? deleted(runId)
        : { runId, outcome: 'already_deleted' }
    );
    const outcome = await performDeleteData({
      world,
      runIds: ['wrun_a', 'wrun_b'],
      confirm: true,
      strict: true,
      logger: makeLogger().logger,
    });
    expect(outcome.exitCode).toBe(0);
  });

  it('sends more than 100 runs in batches of 100, in order', async () => {
    const { world, deleteDataMany } = worldAnswering();
    const runIds = Array.from({ length: 250 }, (_, i) => `wrun_${i}`);

    const outcome = await performDeleteData({
      world,
      runIds,
      confirm: true,
      logger: makeLogger().logger,
    });

    expect(
      deleteDataMany.mock.calls.map(([request]) => request.runIds.length)
    ).toEqual([100, 100, 50]);
    expect(outcome.result?.results.map((r) => r.runId)).toEqual(runIds);
    expect(outcome.result?.summary).toMatchObject({
      requested: 250,
      deleted: 250,
    });
    expect(outcome.exitCode).toBe(0);
  });

  it('retries only the runs that failed retryably, then reports them deleted', async () => {
    let attempts = 0;
    const deleteDataMany = vi.fn(async ({ runIds }: DeleteRunsDataRequest) => {
      attempts++;
      return answer(
        runIds.map((runId) =>
          runId === 'wrun_b' && attempts === 1
            ? retryableFailure(runId)
            : deleted(runId)
        )
      );
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const { logger, warns } = makeLogger();

    const outcome = await performDeleteData({
      world: makeWorld(deleteDataMany),
      runIds: ['wrun_a', 'wrun_b'],
      confirm: true,
      logger,
      sleep,
    });

    expect(deleteDataMany.mock.calls.map(([r]) => r.runIds)).toEqual([
      ['wrun_a', 'wrun_b'],
      ['wrun_b'],
    ]);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(warns[0]).toContain('1 run failed with a retryable error');
    expect(outcome.result?.results).toEqual([
      deleted('wrun_a'),
      deleted('wrun_b'),
    ]);
    expect(outcome.exitCode).toBe(0);
  });

  it(`gives up after ${DELETE_DATA_MAX_ATTEMPTS} attempts and exits 1`, async () => {
    const { world, deleteDataMany } = worldAnswering(retryableFailure);
    const sleep = vi.fn(async (_ms: number) => {});

    const outcome = await performDeleteData({
      world,
      runIds: ['wrun_a'],
      confirm: true,
      logger: makeLogger().logger,
      sleep,
    });

    expect(deleteDataMany).toHaveBeenCalledTimes(DELETE_DATA_MAX_ATTEMPTS);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000, 4_000]);
    expect(outcome.result?.results).toEqual([retryableFailure('wrun_a')]);
    expect(outcome.exitCode).toBe(1);
  });

  it("retries a rate-limited request after the World's retryAfter", async () => {
    const deleteDataMany = vi
      .fn()
      .mockRejectedValueOnce(new ThrottleError('429', { retryAfter: 7 }))
      .mockResolvedValueOnce(answer([deleted('wrun_a')]));
    const sleep = vi.fn(async (_ms: number) => {});
    const { logger, warns } = makeLogger();

    const outcome = await performDeleteData({
      world: makeWorld(deleteDataMany),
      runIds: ['wrun_a'],
      confirm: true,
      logger,
      sleep,
    });

    expect(sleep).toHaveBeenCalledWith(7_000);
    expect(warns[0]).toMatch(/^Rate limited; retrying in 7s/);
    expect(outcome.exitCode).toBe(0);
  });

  it('rethrows a rate limit that outlasts every attempt', async () => {
    const throttle = new ThrottleError('429', { retryAfter: 1 });
    const deleteDataMany = vi.fn().mockRejectedValue(throttle);

    await expect(
      performDeleteData({
        world: makeWorld(deleteDataMany),
        runIds: ['wrun_a'],
        confirm: true,
        logger: makeLogger().logger,
        sleep: noSleep,
      })
    ).rejects.toBe(throttle);
    expect(deleteDataMany).toHaveBeenCalledTimes(DELETE_DATA_MAX_ATTEMPTS);
  });

  it('does not retry an error that is not a rate limit', async () => {
    const deleteDataMany = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      performDeleteData({
        world: makeWorld(deleteDataMany),
        runIds: ['wrun_a'],
        confirm: true,
        logger: makeLogger().logger,
        sleep: noSleep,
      })
    ).rejects.toThrow('boom');
    expect(deleteDataMany).toHaveBeenCalledTimes(1);
  });

  it('deletes nothing, and exits 0, when the user declines the prompt', async () => {
    const deleteDataMany = vi.fn();
    const { logger, logs } = makeLogger();

    const outcome = await performDeleteData({
      world: makeWorld(deleteDataMany),
      runIds: ['wrun_a'],
      confirm: false,
      logger,
      promptConfirm: vi.fn().mockResolvedValue(false),
    });

    expect(outcome).toEqual({ exitCode: 0 });
    expect(logs).toEqual(['Aborted.']);
    expect(deleteDataMany).not.toHaveBeenCalled();
  });

  it('fails without -y when there is no terminal to confirm on', async () => {
    const deleteDataMany = vi.fn();
    const { logger, errors } = makeLogger();

    const outcome = await performDeleteData({
      world: makeWorld(deleteDataMany),
      runIds: ['wrun_a'],
      confirm: false,
      logger,
    });

    // A script that forgets -y must not look like it deleted anything.
    expect(outcome).toEqual({ exitCode: 1 });
    expect(errors).toEqual([DELETE_DATA_NO_TTY_MESSAGE]);
    expect(deleteDataMany).not.toHaveBeenCalled();
  });

  it('skips the prompt with --confirm, and prints only JSON to stdout with --json', async () => {
    const deleteDataMany = vi.fn().mockResolvedValue(mixedResult);
    const promptConfirm = vi.fn();
    const { logger, logs, warns } = makeLogger();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await performDeleteData({
        world: makeWorld(deleteDataMany),
        runIds: ['wrun_a', 'wrun_b', 'wrun_c', 'wrun_d', 'wrun_e'],
        confirm: true,
        json: true,
        logger,
        promptConfirm,
      });
      expect(promptConfirm).not.toHaveBeenCalled();
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual(
        mixedResult
      );
    } finally {
      stdout.mockRestore();
    }
    expect(logs).toEqual([]);
    expect(warns).toEqual([]);
  });

  it('refuses an empty list before prompting', async () => {
    const promptConfirm = vi.fn();
    const { logger, errors } = makeLogger();

    const outcome = await performDeleteData({
      world: worldAnswering().world,
      runIds: [],
      confirm: false,
      logger,
      promptConfirm,
    });

    expect(outcome).toEqual({ exitCode: 1 });
    expect(errors[0]).toMatch(/at least one run ID/);
    expect(promptConfirm).not.toHaveBeenCalled();
  });

  it('reports a World that cannot delete run data before prompting', async () => {
    const promptConfirm = vi.fn();
    const { logger, errors } = makeLogger();

    const outcome = await performDeleteData({
      world: makeWorld(),
      runIds: ['wrun_a'],
      confirm: false,
      logger,
      promptConfirm,
    });

    expect(outcome).toEqual({ exitCode: 1 });
    expect(errors).toEqual([DELETE_DATA_UNSUPPORTED_MESSAGE]);
    expect(promptConfirm).not.toHaveBeenCalled();
  });
});

describe('createPromptConfirm', () => {
  function ask(answerText: string) {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString();
    });
    const answered = createPromptConfirm(input, output)('Delete 1 run?');
    input.write(`${answerText}\n`);
    return answered.then((confirmed) => ({ confirmed, written }));
  }

  it('confirms on y, writing the prompt to the given output only', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(ask('y')).resolves.toEqual({
        confirmed: true,
        written: 'Delete 1 run? [y/N] ',
      });
      // The command passes stderr, so --json output on stdout stays parseable.
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });

  it('declines on anything but y', async () => {
    await expect(ask('n')).resolves.toMatchObject({ confirmed: false });
    await expect(ask('')).resolves.toMatchObject({ confirmed: false });
  });
});
