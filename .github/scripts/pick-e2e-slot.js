// Picks the concurrency slot the Vercel E2E lanes in tests.yml key their
// `concurrency.group` on, and with it the repo-wide cap on how much Vercel
// E2E traffic CI keeps in flight at once.
//
// The lanes group on (lane, matrix cell, slot). Within one run every cell is
// a distinct group, so a single PR still fans its whole matrix out in
// parallel; what collides is the *same* cell from a *different* run. The slot
// count is therefore how many runs' worth of Vercel E2E may overlap
// repo-wide: that many runs get distinct slots and proceed side by side,
// everything past them queues.
//
// The modulo lives here rather than in the workflow because GitHub
// expressions have no arithmetic operators, so the lanes can only read a
// precomputed value through `needs`. Keying on the run id rather than
// something random keeps a re-run of a run in the same slot it had, so a
// re-run queues behind the run it replaces instead of contending with a
// third one.

/**
 * One run's worth of Vercel E2E at a time.
 *
 * Every cell of every Vercel lane deploys to, or tests against, a Vercel
 * project shared by the whole repo (see `.github/scripts/vercel-e2e-matrix.js`),
 * so a second slot means a second run's fan-out pointed at the same projects
 * and the same backend. One slot serializes that cross-run contention while
 * still letting any single PR fan out immediately.
 */
const DEFAULT_SLOTS = 1;

/**
 * Ceiling on E2E_VERCEL_CONCURRENCY_SLOTS.
 *
 * The cap is counted in runs, not jobs, and a run's fan-out is the size of
 * the lane matrices: every workbench app added to `vercel-e2e-matrix.js` adds
 * two prod cells, so what one slot is worth grows on its own, with no rise in
 * how many PRs are open, and each cell also runs longer as the suites grow.
 * Multiplying that by an unbounded repository variable is how the observed
 * peak climbs out from under the cap that is supposed to bound it. Raising
 * this ceiling is deliberately a code change, reviewed against the size of
 * the matrices at the time.
 */
const MAX_SLOTS = 2;

/**
 * Effective slot count for a raw `E2E_VERCEL_CONCURRENCY_SLOTS` value.
 *
 * Unset, blank, and malformed values fall back to the default rather than
 * failing the job: the variable is a convenience dial, and a typo in it
 * should not take the E2E lanes down.
 *
 * @param {string | undefined} raw
 * @returns {{ slots: number, warning: string | null }}
 */
function resolveSlots(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') {
    return { slots: DEFAULT_SLOTS, warning: null };
  }

  if (!/^\d+$/.test(value)) {
    return {
      slots: DEFAULT_SLOTS,
      warning:
        `E2E_VERCEL_CONCURRENCY_SLOTS is not a whole number (${JSON.stringify(value)}); ` +
        `falling back to ${DEFAULT_SLOTS}.`,
    };
  }

  const requested = Number(value);
  if (requested < 1) {
    return {
      slots: 1,
      warning: `E2E_VERCEL_CONCURRENCY_SLOTS is ${requested}; clamping to 1.`,
    };
  }
  if (requested > MAX_SLOTS) {
    return {
      slots: MAX_SLOTS,
      warning:
        `E2E_VERCEL_CONCURRENCY_SLOTS is ${requested}, above the ${MAX_SLOTS}-slot ceiling in ` +
        '.github/scripts/pick-e2e-slot.js; clamping to ' +
        `${MAX_SLOTS}. Raise MAX_SLOTS there if the repo really can absorb more.`,
    };
  }
  return { slots: requested, warning: null };
}

/**
 * Slot index for a run. Non-numeric run ids (only reachable outside Actions)
 * land in slot 0 rather than producing `NaN` in a concurrency group name.
 *
 * @param {{ slots: number, runId: string | number | undefined }} input
 * @returns {number}
 */
function pickSlot({ slots, runId }) {
  const id = Number(String(runId ?? '').trim());
  if (!Number.isSafeInteger(id) || id < 0) {
    return 0;
  }
  return id % slots;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ slot: number, slots: number, warning: string | null, output: string }}
 */
function run(env) {
  const { slots, warning } = resolveSlots(env.E2E_VERCEL_CONCURRENCY_SLOTS);
  const slot = pickSlot({ slots, runId: env.GITHUB_RUN_ID });
  return { slot, slots, warning, output: `slot=${slot}\n` };
}

if (require.main === module) {
  const { slot, slots, warning, output } = run(process.env);
  if (warning) {
    console.error(`::warning::${warning}`);
  }
  console.error(`Vercel E2E lanes use slot ${slot} of ${slots}`);
  // stdout is redirected into $GITHUB_OUTPUT by the workflow step.
  process.stdout.write(output);
}

module.exports = { DEFAULT_SLOTS, MAX_SLOTS, pickSlot, resolveSlots, run };
