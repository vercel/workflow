#!/usr/bin/env node

console.error(`The workflow-postgres-setup command has moved.

Use one of these commands instead:

  # npm
  npx --package=@workflow/world-postgres bootstrap

  # pnpm
  pnpm dlx --package @workflow/world-postgres bootstrap

  # Yarn
  yarn dlx --package @workflow/world-postgres bootstrap

  # Bun
  bunx --package @workflow/world-postgres bootstrap
`);

process.exit(1);
