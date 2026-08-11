import { getStepMetadata, RetryableError, sleep } from 'workflow';

async function prepare(input: string) {
  'use step';
  return `prepared:${input}`;
}

async function finalize(input: string) {
  'use step';
  return `finalized:${input}`;
}

/**
 * A month-long sleep between two steps.
 *
 * Under virtual time this costs nothing: the wait continuation is a queue
 * message dated 30 days out, and delivering it is a clock assignment. The
 * scenario for this workflow is the proof that "all scenarios terminate"
 * survives contact with realistic durations.
 */
export async function longSleepWorkflow(input: string) {
  'use workflow';

  const prepared = await prepare(input);
  await sleep('30d');
  return await finalize(prepared);
}

/**
 * Fails deterministically for its first two attempts, then succeeds.
 *
 * Retry backoff is `delaySeconds` on a queue message, so the retry schedule
 * is virtual too — the scenario observes three `step_started` events and the
 * growing gaps between them without waiting for any of them.
 */
async function flakyStep(label: string) {
  'use step';
  const { attempt } = getStepMetadata();
  if (attempt < 3) {
    throw new RetryableError(`${label} failed on attempt ${attempt}`);
  }
  return `${label}:ok-on-attempt-${attempt}`;
}

export async function retryingWorkflow(label: string) {
  'use workflow';
  return await flakyStep(label);
}

/**
 * Two steps that suspend together, so the world sees interleaved
 * `step_started` / `step_completed` pairs for distinct correlation IDs.
 */
export async function parallelStepsWorkflow(input: string) {
  'use workflow';
  const [a, b] = await Promise.all([prepare(input), finalize(input)]);
  return `${a}|${b}`;
}

/** Nothing but a return value: the smallest log a completed run can have. */
export async function emptyWorkflow() {
  'use workflow';
  return 'done';
}

async function noopStep() {
  'use step';
  return null;
}

/** One step that does nothing. The smallest log that exercises the step path. */
export async function oneStepWorkflow() {
  'use workflow';
  return await noopStep();
}
