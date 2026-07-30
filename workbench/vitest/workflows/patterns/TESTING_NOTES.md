# Pattern testing notes

The files in this directory are the **canonical source** for the docs
patterns registry (`docs/lib/patterns/`). They are real, compiled,
executable workflow files; `docs/scripts/sync-pattern-source.ts` derives the
docs snippet strings from them. **Edit these files, never the generated
snippet strings.** After editing, run `pnpm sync-pattern-source` from
`docs/`.

Tests live in `../../test/patterns-*.test.ts` with driver workflows in
`../drivers/`. Hard-won rules from getting the first suites green:

1. **Side-effect counters in driver steps MUST dedupe by `stepId`.** Step
   execution is at-least-once — the runtime can retry a step whose side
   effects already ran (observed in practice: `attempt: 2` on healthy
   steps under parallel load). Pattern: `getStepMetadata().stepId` + a
   module-level `Set`, skip if seen. Without this, concurrency counters
   double-count and tests lie.
2. **Unique keys per vitest invocation.** The local world persists across
   runs, so a coordinator from the previous `vitest run` can still own a
   token. Derive keys in the test file: `const RUN = Date.now().toString(36)`
   (test files aren't workflows — wall clock is fine there, never in
   workflow code).
3. **Cancel leftover coordinators in `afterAll`** via
   `getHookByToken(token) → getRun(runId).cancel()` so suites don't leak
   live runs into the next suite.
4. **Force-wake sleeps instead of waiting:** `waitForSleep(run)` →
   `getRun(run.runId).wakeUp({ correlationIds: [id] })` (see
   `cookbook-common.test.ts`). Never shrink production constants for
   testability.
5. **No real network in canonical files.** Replaceable action steps
   (`flushBatch`, `runJob`, `onDebounceFire`, …) must be self-contained
   demos that run out of the box — in-memory state, computed results, or a
   logged no-op, with a comment block showing what a real implementation
   (fetch to your API) looks like. `api.example.com` fetches fail DNS and
   poison the step with retries — and an installed pattern should work on
   first run anyway.
6. **Drivers must be workflows.** `withPermit`-style consumer APIs create
   hooks and race durable sleeps, so they can only be called from
   `"use workflow"` functions — test files call `start(driver, args)` and
   assert on `run.returnValue`.
7. **`vi.mock` does not reach step internals** (step deps are bundled —
   see `../../MOCKING.md`). Design observability into drivers (return
   values, module state read by a final step) rather than mocking.
