import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    // Positional file arguments are regex filters, not paths, so
    // `vitest run packages/core/e2e/x.test.ts` also matches
    // `.claude/worktrees/<name>/packages/core/e2e/x.test.ts` when agent
    // worktrees live inside the repo (see .gitignore). Those copies belong to
    // other branches: they would run their own version of the suite against the
    // same backend and overwrite the same result files.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
