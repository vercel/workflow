import type { DeleteRunsDataResult } from '@workflow/world';
import { getWorldLazy } from './get-world-lazy.js';
import { deleteRuns as deleteRunsInWorld } from './runs.js';

/**
 * Delete the stored data of up to 100 finished runs in one call, using the
 * configured World: their inputs, outputs and errors, their steps' and
 * events' payloads, their hook payloads, and their stream contents. This
 * cannot be undone.
 *
 * Metadata is not deleted: despite the name, the runs themselves stay
 * listed, and so do their steps, events and hooks, with their IDs, names,
 * statuses, timestamps and the runs' attributes. Only their payloads go,
 * reading back as expired.
 *
 * Runs that have not finished are answered `skipped` and left running. Every
 * outcome is reported per run, in the order of `runIds`. Called inside a
 * step, retryable failures throw a `RetryableError` so the step retries;
 * outside a step they are returned for the caller to retry.
 *
 * For a single run, use `getRun(runId).deleteData()`.
 *
 * @throws if `runIds` is empty, contains duplicates or more than 100 IDs, or
 *   if the configured World does not support deleting run data.
 */
export async function deleteRuns(
  runIds: string[]
): Promise<DeleteRunsDataResult> {
  return deleteRunsInWorld(await getWorldLazy(), runIds);
}
