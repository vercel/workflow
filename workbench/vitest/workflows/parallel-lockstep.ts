import { appendFile } from 'node:fs/promises';

/**
 * Step that records when its body entered and when it left, so a test can
 * reconstruct the timeline of a fan-out. `label` identifies the branch and
 * the position within it (e.g. `fast2`).
 */
async function tick(markerPath: string, label: string, ms: number) {
  'use step';
  await appendFile(markerPath, `${label} start ${Date.now()}\n`);
  await new Promise((resolve) => setTimeout(resolve, ms));
  await appendFile(markerPath, `${label} end ${Date.now()}\n`);
  return label;
}

/**
 * Repro workflow for issue #4457: two sequential chains run side by side in
 * one `Promise.all`. One chain's steps are fast, the other's are slow.
 *
 * The fast chain should finish after roughly `3 * fastMs`, independently of
 * the slow chain. Under lockstep it instead finishes after roughly
 * `2 * slowMs + fastMs`, because each of its steps is only created once the
 * slow chain's in-flight step has ended.
 */
export async function parallelLockstepWorkflow(
  markerPath: string,
  fastMs: number,
  slowMs: number
) {
  'use workflow';

  await Promise.all([
    (async () => {
      await tick(markerPath, 'fast1', fastMs);
      await tick(markerPath, 'fast2', fastMs);
      await tick(markerPath, 'fast3', fastMs);
    })(),
    (async () => {
      await tick(markerPath, 'slow1', slowMs);
      await tick(markerPath, 'slow2', slowMs);
      await tick(markerPath, 'slow3', slowMs);
    })(),
  ]);

  return 'done';
}

/**
 * Same fan-out as {@link parallelLockstepWorkflow}, with the branches listed
 * in the opposite order, so the slow chain is the one that takes the first
 * inline step slot.
 *
 * This separates the two lockstep paths. With `WORKFLOW_MAX_INLINE_STEPS=1`
 * exactly one of the two branches runs inline and the other is dispatched to
 * the queue; the inline one advances freely (the inline loop replays after
 * its own step), while the dispatched one is gated by the background path,
 * which returns without replaying while any sibling step is pending.
 */
export async function parallelLockstepSlowFirstWorkflow(
  markerPath: string,
  fastMs: number,
  slowMs: number
) {
  'use workflow';

  await Promise.all([
    (async () => {
      await tick(markerPath, 'slow1', slowMs);
      await tick(markerPath, 'slow2', slowMs);
      await tick(markerPath, 'slow3', slowMs);
    })(),
    (async () => {
      await tick(markerPath, 'fast1', fastMs);
      await tick(markerPath, 'fast2', fastMs);
      await tick(markerPath, 'fast3', fastMs);
    })(),
  ]);

  return 'done';
}
