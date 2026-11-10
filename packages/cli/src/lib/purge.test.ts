import { PassThrough } from 'node:stream';
import type {
  BulkPurgeWorkflowRunsRequest,
  BulkPurgeWorkflowRunsResult,
  World,
} from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import {
  createPromptConfirm,
  formatPurgeSummary,
  PURGE_NO_TTY_MESSAGE,
  PURGE_UNSUPPORTED_MESSAGE,
  performPurge,
  purgeFailureLines,
  validatePurgeRunIds,
} from './purge.js';

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

const emptySummary = {
  requested: 0,
  purged: 0,
  alreadyPurged: 0,
  skipped: 0,
  notCreated: 0,
  notFound: 0,
  failed: 0,
};

const mixedResult: BulkPurgeWorkflowRunsResult = {
  summary: {
    ...emptySummary,
    requested: 5,
    purged: 1,
    alreadyPurged: 1,
    skipped: 1,
    notFound: 1,
    failed: 1,
  },
  results: [
    { runId: 'wrun_a', outcome: 'purged' },
    { runId: 'wrun_b', outcome: 'already_purged' },
    {
      runId: 'wrun_c',
      outcome: 'skipped',
      reason: 'run_not_terminal',
      status: 'running',
    },
    { runId: 'wrun_d', outcome: 'not_found' },
    {
      runId: 'wrun_e',
      outcome: 'failed',
      code: 'internal_error',
      retryable: true,
    },
  ],
};

/** A fake World that purges with `purgeMany`, attached only when given. */
function makeWorld(
  purgeMany?: (
    request: BulkPurgeWorkflowRunsRequest
  ) => Promise<BulkPurgeWorkflowRunsResult>
): World {
  return {
    runs: { ...(purgeMany ? { purgeMany } : {}) },
  } as unknown as World;
}

describe('validatePurgeRunIds', () => {
  it('accepts 1 to 100 run IDs', () => {
    expect(validatePurgeRunIds(['wrun_a'])).toBeUndefined();
    expect(
      validatePurgeRunIds(Array.from({ length: 100 }, (_, i) => `wrun_${i}`))
    ).toBeUndefined();
  });

  it('rejects none, and more than 100', () => {
    expect(validatePurgeRunIds([])).toMatch(/at least one run ID/);
    expect(
      validatePurgeRunIds(Array.from({ length: 101 }, (_, i) => `wrun_${i}`))
    ).toMatch(/at most 100 runs/);
  });
});

describe('formatPurgeSummary', () => {
  it('counts every outcome, with `not_created` runs as purged', () => {
    expect(
      formatPurgeSummary({
        summary: { ...mixedResult.summary, notCreated: 1 },
        results: [],
      })
    ).toBe(
      [
        'Done:',
        '  2 purged',
        '  1 already purged',
        '  1 skipped (not finished)',
        '  1 not found',
        '  1 failed',
      ].join('\n')
    );
  });
});

describe('purgeFailureLines', () => {
  it('calls out skipped, missing, and failed runs only', () => {
    expect(purgeFailureLines(mixedResult)).toEqual([
      '  ✗ wrun_c: skipped, the run has not finished (running). Cancel it first to purge it.',
      '  ✗ wrun_d: not found',
      '  ✗ wrun_e: failed (internal_error, retryable)',
    ]);
  });
});

describe('performPurge', () => {
  it('purges the confirmed runs once, deduplicated, and exits 1 on a failure', async () => {
    const purgeMany = vi.fn().mockResolvedValue(mixedResult);
    const promptConfirm = vi.fn().mockResolvedValue(true);
    const { logger, logs, warns } = makeLogger();

    const outcome = await performPurge({
      world: makeWorld(purgeMany),
      runIds: ['wrun_a', 'wrun_b', 'wrun_a'],
      confirm: false,
      logger,
      promptConfirm,
    });

    expect(promptConfirm).toHaveBeenCalledWith(
      'Permanently delete the data of 2 runs? This cannot be undone.'
    );
    expect(purgeMany).toHaveBeenCalledTimes(1);
    expect(purgeMany).toHaveBeenCalledWith({ runIds: ['wrun_a', 'wrun_b'] });
    expect(warns).toHaveLength(3);
    expect(logs.at(-1)).toContain('Done:');
    expect(outcome).toEqual({ exitCode: 1, result: mixedResult });
  });

  it('exits 0 when nothing failed, even if runs were skipped or missing', async () => {
    const purgeMany = vi.fn().mockResolvedValue({
      summary: { ...emptySummary, requested: 2, skipped: 1, notFound: 1 },
      results: [
        {
          runId: 'wrun_a',
          outcome: 'skipped',
          reason: 'run_not_terminal',
          status: 'pending',
        },
        { runId: 'wrun_b', outcome: 'not_found' },
      ],
    });
    const { logger } = makeLogger();

    const outcome = await performPurge({
      world: makeWorld(purgeMany),
      runIds: ['wrun_a', 'wrun_b'],
      confirm: true,
      logger,
    });

    expect(outcome.exitCode).toBe(0);
  });

  it('purges nothing, and exits 0, when the user declines the prompt', async () => {
    const purgeMany = vi.fn();
    const { logger, logs } = makeLogger();

    const outcome = await performPurge({
      world: makeWorld(purgeMany),
      runIds: ['wrun_a'],
      confirm: false,
      logger,
      promptConfirm: vi.fn().mockResolvedValue(false),
    });

    expect(outcome).toEqual({ exitCode: 0 });
    expect(logs).toEqual(['Aborted.']);
    expect(purgeMany).not.toHaveBeenCalled();
  });

  it('fails without -y when there is no terminal to confirm on', async () => {
    const purgeMany = vi.fn();
    const { logger, errors } = makeLogger();

    const outcome = await performPurge({
      world: makeWorld(purgeMany),
      runIds: ['wrun_a'],
      confirm: false,
      logger,
    });

    // A script that forgets -y must not look like it purged.
    expect(outcome).toEqual({ exitCode: 1 });
    expect(errors).toEqual([PURGE_NO_TTY_MESSAGE]);
    expect(purgeMany).not.toHaveBeenCalled();
  });

  it('skips the prompt with --confirm, and prints JSON with --json', async () => {
    const purgeMany = vi.fn().mockResolvedValue(mixedResult);
    const promptConfirm = vi.fn();
    const { logger, logs, warns } = makeLogger();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await performPurge({
      world: makeWorld(purgeMany),
      runIds: ['wrun_a'],
      confirm: true,
      json: true,
      logger,
      promptConfirm,
    });

    expect(promptConfirm).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(
      `${JSON.stringify(mixedResult, null, 2)}\n`
    );
    stdout.mockRestore();
    expect(logs).toEqual([]);
    expect(warns).toEqual([]);
  });

  it('refuses more than 100 run IDs before prompting', async () => {
    const purgeMany = vi.fn();
    const promptConfirm = vi.fn();
    const { logger, errors } = makeLogger();

    const outcome = await performPurge({
      world: makeWorld(purgeMany),
      runIds: Array.from({ length: 101 }, (_, i) => `wrun_${i}`),
      confirm: false,
      logger,
      promptConfirm,
    });

    expect(outcome).toEqual({ exitCode: 1 });
    expect(errors[0]).toMatch(/at most 100 runs/);
    expect(promptConfirm).not.toHaveBeenCalled();
    expect(purgeMany).not.toHaveBeenCalled();
  });

  it('reports a World that cannot purge before prompting', async () => {
    const promptConfirm = vi.fn();
    const { logger, errors } = makeLogger();

    const outcome = await performPurge({
      world: makeWorld(),
      runIds: ['wrun_a'],
      confirm: false,
      logger,
      promptConfirm,
    });

    expect(outcome).toEqual({ exitCode: 1 });
    expect(errors).toEqual([PURGE_UNSUPPORTED_MESSAGE]);
    expect(promptConfirm).not.toHaveBeenCalled();
  });
});

describe('createPromptConfirm', () => {
  function ask(answer: string) {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString();
    });
    const answered = createPromptConfirm(input, output)('Purge 1 run?');
    input.write(`${answer}\n`);
    return answered.then((confirmed) => ({ confirmed, written }));
  }

  it('confirms on y, writing the prompt to the given output only', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(ask('y')).resolves.toEqual({
        confirmed: true,
        written: 'Purge 1 run? [y/N] ',
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

describe('performPurge with --json and an answered prompt', () => {
  it('writes only the JSON result to stdout', async () => {
    const purgeMany = vi.fn().mockResolvedValue(mixedResult);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { logger } = makeLogger();
    try {
      await performPurge({
        world: makeWorld(purgeMany),
        runIds: ['wrun_a'],
        confirm: false,
        json: true,
        logger,
        promptConfirm: vi.fn().mockResolvedValue(true),
      });
      expect(stdout).toHaveBeenCalledTimes(1);
      const written = String(stdout.mock.calls[0]?.[0]);
      expect(JSON.parse(written)).toEqual(mixedResult);
    } finally {
      stdout.mockRestore();
    }
  });
});
