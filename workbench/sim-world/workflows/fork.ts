import { createHook, sleep } from 'workflow';

/** Step 1. Does nothing; it exists to put a step boundary before the race. */
async function stepOne() {
  'use step';
  return null;
}

/** Step 2 — the "hook arrived" branch. */
async function stepTwo(documentId: string) {
  'use step';
  return `step2:${documentId}`;
}

/** Step 3 — the "timed out, no hook" branch. */
async function stepThree(documentId: string) {
  'use step';
  return `step3:${documentId}`;
}

/**
 * step 1 → wait for the hook with a timeout → branch on which won.
 *
 * The dangerous window is between `wait_completed` (the timeout firing) and the
 * commit of whichever branch step gets chosen. A payload delivered there is
 * durably *ahead* of the branch in the log while the first execution decided
 * the branch without it — so a replay reaching the race sees both competitors
 * resolvable and has to pick the same one, on log position alone.
 */
export async function hookTimeoutForkWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `fork:${documentId}`,
  });

  await stepOne();

  const arrived = await Promise.race([
    hook.then(() => true),
    sleep('1m').then(() => false),
  ]);

  return arrived ? await stepTwo(documentId) : await stepThree(documentId);
}

async function settle(documentId: string) {
  'use step';
  return `settled:${documentId}`;
}

async function recoverFirst(documentId: string) {
  'use step';
  return `recovered:${documentId}`;
}

async function recoverSecond(previous: string) {
  'use step';
  return `${previous}+second`;
}

async function reconcile(tail: string) {
  'use step';
  return `reconciled(${tail})`;
}

/**
 * The same fork, but the two paths emit a *different number of steps*.
 *
 * This is the amplifier the shape above was missing. Correlation IDs are
 * positional ordinals of one seeded sequence, so when the settle path emits one
 * step and the recovery path emits two, a replay that flips the branch renames
 * every entity after the fork. The log then contains a `step_created` nobody
 * asks for, which is an unrecoverable divergence rather than a benign retry
 * that happens to mint the same ids.
 *
 * `reconcile` exists to carry the shift past the fork: its ordinal differs by
 * one between the two paths.
 */
export async function stepCountForkWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `count:${documentId}`,
  });

  await stepOne();

  const arrived = await Promise.race([
    hook.then(() => true),
    sleep('1m').then(() => false),
  ]);

  let tail: string;
  if (arrived) {
    tail = await recoverSecond(await recoverFirst(documentId));
  } else {
    tail = await settle(documentId);
  }

  return await reconcile(tail);
}

/**
 * The same fork again, with one addition: the run suspends *after* the branch.
 *
 * Every check a write can meet happens inside the write itself — the fence is
 * a conditional append, evaluated against the log as it stands at that
 * instant. So the only moment at which a late-committing event can land
 * without meeting any check at all is one where the run is making no writes:
 * the gap between one delivery ending and the next beginning. This workflow
 * creates such a gap in the middle of a run, which is where the third
 * in-flight scenario lands its hook.
 *
 * Suspending after the branch (rather than letting the run finish) also keeps
 * the hook alive. A run that has completed has disposed its hooks and gone
 * terminal, and a `hook_received` arriving then is refused for reasons that
 * have nothing to do with concurrency — which would hide the hazard rather
 * than test it.
 */
export async function lateAppendForkWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `count:${documentId}`,
  });

  await stepOne();

  const arrived = await Promise.race([
    hook.then(() => true),
    sleep('1m').then(() => false),
  ]);

  const tail = arrived
    ? await recoverSecond(await recoverFirst(documentId))
    : await settle(documentId);

  // The quiescent window. `wait_created` is the last write this delivery
  // makes; nothing of this run is checked again until the timer fires.
  await sleep('1m');

  return await reconcile(tail);
}
