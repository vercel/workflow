import readline from 'node:readline';
import { deleteRunData } from '@workflow/core/runtime';
import { ThrottleError } from '@workflow/errors';
import {
  DELETE_RUNS_DATA_MAX_RUN_IDS,
  type DeleteRunDataResult,
  type DeleteRunsDataResult,
  type World,
} from '@workflow/world';

/** Printed when the configured World cannot delete run data. */
export const DELETE_UNSUPPORTED_MESSAGE =
  'The configured World does not support deleting run data.';

/**
 * Printed when a deletion needs confirming and there is no terminal to ask
 * on: a script that forgets `-y` must not look like it deleted anything.
 */
export const DELETE_NO_TTY_MESSAGE =
  'No terminal to confirm the deletion on; pass -y/--confirm to delete non-interactively.';

/** How often a batch is sent in all, counting the first try. */
export const DELETE_MAX_ATTEMPTS = 4;

/** Wait before the first retry; doubles for each one after it. */
const RETRY_BASE_DELAY_MS = 1_000;

/** The longest wait between attempts, whatever the World asks for. */
const RETRY_MAX_DELAY_MS = 60_000;

/**
 * A `[y/N]` confirmation prompt over the given streams. The command passes
 * stdin and **stderr**, so the prompt never lands in output redirected from
 * stdout, such as `--json` results.
 */
export function createPromptConfirm(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream
): (message: string) => Promise<boolean> {
  return (message) =>
    new Promise<boolean>((resolve) => {
      const rl = readline.createInterface({ input, output });
      rl.question(`${message} [y/N] `, (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === 'y');
      });
    });
}

/**
 * The run IDs in `input`, one per line or separated by any whitespace, as
 * `workflow delete -` reads them from stdin.
 */
export async function readRunIds(
  input: AsyncIterable<string | Buffer>
): Promise<string[]> {
  let text = '';
  for await (const chunk of input) {
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
  return text.split(/\s+/).filter((runId) => runId.length > 0);
}

export interface DeleteLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * The compact multi-line "Done:" summary block. Lists every outcome so the
 * counts add up to the number of runs requested; runs worth calling out are
 * additionally listed by {@link deleteFailureLines}. A `not_created` run
 * (cancelled before it was ever created) counts as deleted; `--json` keeps
 * it separate.
 */
export function formatDeleteSummary(result: DeleteRunsDataResult): string {
  const { summary } = result;
  return [
    'Done:',
    `  ${summary.deleted + summary.notCreated} deleted`,
    `  ${summary.alreadyDeleted} already deleted`,
    `  ${summary.skipped} skipped (not finished)`,
    `  ${summary.notFound} not found`,
    `  ${summary.failed} failed`,
  ].join('\n');
}

/**
 * Per-run lines for outcomes worth calling out individually: runs that were
 * skipped because they have not finished, runs that were not found, and
 * failures.
 */
export function deleteFailureLines(result: DeleteRunsDataResult): string[] {
  const lines: string[] = [];
  for (const r of result.results) {
    switch (r.outcome) {
      case 'skipped':
        lines.push(
          `  ✗ ${r.runId}: skipped, the run has not finished (${r.status}). Cancel it first to delete its data.`
        );
        break;
      case 'not_found':
        lines.push(`  ✗ ${r.runId}: not found`);
        break;
      case 'failed':
        lines.push(
          `  ✗ ${r.runId}: failed (${r.code}${r.retryable ? `, still failing after ${DELETE_MAX_ATTEMPTS} attempts` : ''})`
        );
        break;
    }
  }
  return lines;
}

/** The result for `results`, in order, with its summary counted. */
function summarize(results: DeleteRunDataResult[]): DeleteRunsDataResult {
  const count = (outcome: DeleteRunDataResult['outcome']) =>
    results.filter((result) => result.outcome === outcome).length;
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

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Delete one batch of at most {@link DELETE_RUNS_DATA_MAX_RUN_IDS} runs'
 * data, retrying what can succeed on a retry: runs answered `failed` with
 * `retryable: true`, and the whole request when the World rate-limits it
 * (after the World's `retryAfter`, when it gives one). Deletion is
 * idempotent, so a retry only finishes what an attempt left. After
 * {@link DELETE_MAX_ATTEMPTS} attempts the last answer stands.
 */
async function deleteBatchWithRetries(
  world: World,
  runIds: string[],
  logger: DeleteLogger,
  sleep: (ms: number) => Promise<void>
): Promise<DeleteRunDataResult[]> {
  const resultByRunId = new Map<string, DeleteRunDataResult>();
  let pending = runIds;
  for (let attempt = 1; ; attempt++) {
    let reason: string;
    let delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    try {
      const { results } = await deleteRunData(world, pending);
      for (const result of results) resultByRunId.set(result.runId, result);
      pending = results
        .filter((result) => result.outcome === 'failed' && result.retryable)
        .map((result) => result.runId);
      if (pending.length === 0) break;
      reason = `${pending.length} run${pending.length === 1 ? '' : 's'} failed with a retryable error`;
    } catch (err) {
      if (!ThrottleError.is(err)) throw err;
      // Out of attempts: the last answer stands, if there was one.
      if (attempt >= DELETE_MAX_ATTEMPTS && resultByRunId.size === 0) {
        throw err;
      }
      reason = 'Rate limited';
      if (typeof err.retryAfter === 'number') {
        delayMs = err.retryAfter * 1000;
      }
    }
    if (attempt >= DELETE_MAX_ATTEMPTS) break;

    delayMs = Math.min(Math.max(delayMs, 0), RETRY_MAX_DELAY_MS);
    logger.warn(
      `${reason}; retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${attempt + 1} of ${DELETE_MAX_ATTEMPTS}).`
    );
    await sleep(delayMs);
  }
  return runIds.map((runId) => resultByRunId.get(runId) as DeleteRunDataResult);
}

export interface DeleteParams {
  world: World;
  runIds: string[];
  /** When true, skip the interactive confirmation prompt. */
  confirm: boolean;
  /** Print the structured result as JSON instead of the summary. */
  json?: boolean;
  /**
   * Exit 1 unless every run's data is gone: also when a run was not found
   * or has not finished, not only when one failed.
   */
  strict?: boolean;
  logger: DeleteLogger;
  /**
   * Confirmation prompt. Omitted when there is no terminal to ask on, in
   * which case an unconfirmed deletion fails with
   * {@link DELETE_NO_TTY_MESSAGE}.
   */
  promptConfirm?: (message: string) => Promise<boolean>;
  /** Waits between retries. Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface DeleteOutcome {
  /**
   * Process exit code: 1 when the input was invalid, the deletion could not
   * be confirmed, or any run failed (or, with `strict`, was not found or not
   * finished); 0 when the user declined the prompt.
   */
  exitCode: number;
  /** The structured result, or undefined when aborted. */
  result?: DeleteRunsDataResult;
}

/**
 * Confirm, then delete the stored data of the given finished runs, in
 * batches of {@link DELETE_RUNS_DATA_MAX_RUN_IDS}. Runs that have not
 * finished are skipped and left running. Duplicate IDs are handled once.
 * Retryable failures are retried; see {@link deleteBatchWithRetries}.
 */
export async function performDelete(
  params: DeleteParams
): Promise<DeleteOutcome> {
  const { world, confirm, json, strict, logger, promptConfirm } = params;
  const sleep = params.sleep ?? defaultSleep;
  const runIds = [...new Set(params.runIds)];

  if (runIds.length === 0) {
    logger.error('Provide at least one run ID whose data to delete.');
    return { exitCode: 1 };
  }
  // Checked before prompting: confirming a deletion the World then refuses
  // would leave the user wondering what happened.
  if (!world.runs.deleteDataMany) {
    logger.error(DELETE_UNSUPPORTED_MESSAGE);
    return { exitCode: 1 };
  }

  if (!confirm) {
    if (!promptConfirm) {
      logger.error(DELETE_NO_TTY_MESSAGE);
      return { exitCode: 1 };
    }
    const confirmed = await promptConfirm(
      `Permanently delete the data of ${runIds.length} run${runIds.length === 1 ? '' : 's'}? This cannot be undone.`
    );
    if (!confirmed) {
      logger.log('Aborted.');
      return { exitCode: 0 };
    }
  }

  const results: DeleteRunDataResult[] = [];
  for (let i = 0; i < runIds.length; i += DELETE_RUNS_DATA_MAX_RUN_IDS) {
    results.push(
      ...(await deleteBatchWithRetries(
        world,
        runIds.slice(i, i + DELETE_RUNS_DATA_MAX_RUN_IDS),
        logger,
        sleep
      ))
    );
  }
  const result = summarize(results);

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const line of deleteFailureLines(result)) {
      logger.warn(line);
    }
    logger.log(`\n${formatDeleteSummary(result)}`);
  }

  // Skipped, already deleted, and missing runs are valid partial outcomes;
  // only a genuine failure is a nonzero exit, unless `strict`.
  const { failed, notFound, skipped } = result.summary;
  const incomplete = failed > 0 || (strict && notFound + skipped > 0);
  return { exitCode: incomplete ? 1 : 0, result };
}
