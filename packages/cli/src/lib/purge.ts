import readline from 'node:readline';
import { purgeRuns } from '@workflow/core/runtime';
import {
  BULK_PURGE_MAX_RUN_IDS,
  type BulkPurgeWorkflowRunsResult,
  type World,
} from '@workflow/world';

/** Printed when the configured World cannot purge run data. */
export const PURGE_UNSUPPORTED_MESSAGE =
  'The configured World does not support purging run data. To purge runs on Vercel, pass `--backend vercel`.';

/**
 * Printed when a purge needs confirming and there is no terminal to ask on:
 * a script that forgets `-y` must not look like it purged.
 */
export const PURGE_NO_TTY_MESSAGE =
  'No terminal to confirm the purge on; pass -y/--confirm to purge non-interactively.';

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

export interface PurgeLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Validate the run IDs given to `workflow purge`. Returns an error message
 * when invalid, or `undefined` when there are 1–{@link BULK_PURGE_MAX_RUN_IDS}
 * unique IDs.
 */
export function validatePurgeRunIds(runIds: string[]): string | undefined {
  if (runIds.length === 0) {
    return 'Provide at least one run ID to purge.';
  }
  if (runIds.length > BULK_PURGE_MAX_RUN_IDS) {
    return `You can purge at most ${BULK_PURGE_MAX_RUN_IDS} runs at a time (received ${runIds.length}).`;
  }
  return undefined;
}

/**
 * The compact multi-line "Done:" summary block. Lists every outcome so the
 * counts add up to the number of runs requested; runs worth calling out are
 * additionally listed by {@link purgeFailureLines}.
 */
export function formatPurgeSummary(
  result: BulkPurgeWorkflowRunsResult
): string {
  const { summary } = result;
  return [
    'Done:',
    `  ${summary.purged + summary.notCreated} purged`,
    `  ${summary.alreadyPurged} already purged`,
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
export function purgeFailureLines(
  result: BulkPurgeWorkflowRunsResult
): string[] {
  const lines: string[] = [];
  for (const r of result.results) {
    switch (r.outcome) {
      case 'skipped':
        lines.push(
          `  ✗ ${r.runId}: skipped, the run has not finished (${r.status}). Cancel it first to purge it.`
        );
        break;
      case 'not_found':
        lines.push(`  ✗ ${r.runId}: not found`);
        break;
      case 'failed':
        lines.push(
          `  ✗ ${r.runId}: failed (${r.code}${r.retryable ? ', retryable' : ''})`
        );
        break;
    }
  }
  return lines;
}

export interface PurgeParams {
  world: World;
  runIds: string[];
  /** When true, skip the interactive confirmation prompt. */
  confirm: boolean;
  /** Print the structured result as JSON instead of the summary. */
  json?: boolean;
  logger: PurgeLogger;
  /**
   * Confirmation prompt. Omitted when there is no terminal to ask on, in
   * which case an unconfirmed purge fails with {@link PURGE_NO_TTY_MESSAGE}.
   */
  promptConfirm?: (message: string) => Promise<boolean>;
}

export interface PurgeOutcome {
  /**
   * Process exit code: 1 when the input was invalid, the purge could not be
   * confirmed, or any run failed; 0 when the user declined the prompt.
   */
  exitCode: number;
  /** The structured result, or undefined when aborted. */
  result?: BulkPurgeWorkflowRunsResult;
}

/**
 * Confirm, then delete the stored data of the given finished runs in one
 * operation. Runs that have not finished are skipped and left running.
 * Duplicate IDs are purged once.
 */
export async function performPurge(params: PurgeParams): Promise<PurgeOutcome> {
  const { world, confirm, json, logger, promptConfirm } = params;
  const runIds = [...new Set(params.runIds)];

  const invalid = validatePurgeRunIds(runIds);
  if (invalid) {
    logger.error(invalid);
    return { exitCode: 1 };
  }
  // Checked before prompting: confirming a purge the World then refuses
  // would leave the user wondering what happened.
  if (!world.runs.purgeMany) {
    logger.error(PURGE_UNSUPPORTED_MESSAGE);
    return { exitCode: 1 };
  }

  if (!confirm) {
    if (!promptConfirm) {
      logger.error(PURGE_NO_TTY_MESSAGE);
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

  const result = await purgeRuns(world, runIds);

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const line of purgeFailureLines(result)) {
      logger.warn(line);
    }
    logger.log(`\n${formatPurgeSummary(result)}`);
  }

  // Skipped, already purged, and missing runs are valid partial outcomes;
  // only a genuine failure is a nonzero exit.
  return { exitCode: result.summary.failed > 0 ? 1 : 0, result };
}
