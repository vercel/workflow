import type { DeleteRunsDataResult } from '@workflow/world';
import { getWorldLazy } from './get-world-lazy.js';
import { deleteRunsData as deleteRunsDataInWorld } from './runs.js';

/**
 * Delete the stored data of up to 100 finished runs in one call, using the
 * configured World: their inputs, outputs and errors, their steps' and
 * events' payloads, their hook payloads, and their stream contents. The runs
 * stay listed. This cannot be undone.
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
export async function deleteRunsData(
  runIds: string[]
): Promise<DeleteRunsDataResult> {
  return deleteRunsDataInWorld(await getWorldLazy(), runIds);
}
