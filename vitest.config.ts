import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    // Fixture hooks get the budget of the tests they set up. Vitest's 10s
    // default assumes an idle disk: on a Windows runner the world-local suite
    // runs its filesystem-heavy files in parallel against one slow temp
    // volume, and a `beforeEach` that writes ten small JSON files
    // (fs.test.ts) stalled past 10s while a sibling file was pushing a
    // thousand events through the same disk. Main's green run had that
    // whole 78-test file at 6.7s, so the hook is not what is slow. A test
    // body doing the same writes would have had 60s.
    hookTimeout: 60_000,
    // Deployment e2e suites can lose timing races to queue delays, cold
    // starts, and watcher latency. They always set DEPLOYMENT_URL, so keep
    // their one visible retry without masking deterministic unit/integration
    // failures elsewhere in `turbo test`. The github-reporter annotates
    // retried e2e tests and includes them in the PR summary. Harnesses where
    // a failure is itself the signal (event-log-race-repro, benchmarks) pin
    // `retry: 0` locally. Local runs also keep retry at 0 for reproduction.
    retry: process.env.CI && process.env.DEPLOYMENT_URL ? 1 : 0,
    // How many concurrent tests vitest runs from a `describe.concurrent`
    // suite (vitest's own default is 5). Only the e2e conformance suite is
    // concurrent, so this is effectively its dial. Tunable because the right
    // value is a property of the runner and the deployment rather than of
    // the tests: every CLI assertion spawns a `node` child, and a CI runner
    // has few cores, so too high a value inflates per-test latency until
    // tests exceed budgets written for an unloaded suite. Each lane logs
    // what it observed (see `summarizeLoad` in the e2e utils).
    maxConcurrency: Number(process.env.WORKFLOW_E2E_MAX_CONCURRENCY ?? 5),
    // Positional file arguments are regex filters, not paths, so
    // `vitest run packages/core/e2e/x.test.ts` also matches
    // `.claude/worktrees/<name>/packages/core/e2e/x.test.ts` when agent
    // worktrees live inside the repo (see .gitignore). Those copies belong to
    // other branches: they would run their own version of the suite against the
    // same backend and overwrite the same result files.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
