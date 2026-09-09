#!/usr/bin/env node
/**
 * Fails when the pending changesets cannot be assembled into a release plan.
 *
 * `changeset version`, which .github/workflows/release.yml runs on every push
 * to `main`, builds a release plan from every file in `.changeset/` before it
 * bumps a single version. Two kinds of changeset make that step throw, and
 * the throw leaves `main` unpublishable until someone reads the red Release
 * job:
 *
 *   - one naming a package that is not in the workspace (a typo, or a
 *     package renamed or removed after the changeset was written);
 *   - one mixing packages from `.changeset/config.json#ignore` (private
 *     workbench and simulation packages such as `@workflow/world-sim`) with
 *     published ones. Changesets rejects the whole file rather than dropping
 *     the ignored entries. #3938 shipped one of these and blocked every
 *     release until #3963.
 *
 * Nothing at PR time exercised that step. `changeset status --since=main`
 * does not see a changeset once it is on the base branch, and it also fails
 * for the unrelated reason of a package changing without a changeset, so it
 * cannot serve as this gate. This script runs the same assembly `changeset
 * version` runs, on the same inputs, and stops there: it skips the changelog
 * generation, which is the slow, network-bound part of the real command, so
 * it is cheap enough to run on every PR.
 *
 * The libraries are resolved from `@changesets/cli`'s own install rather than
 * declared as root dependencies. That keeps them at exactly the versions the
 * CLI uses, so this check cannot drift from what the Release job will do, and
 * it avoids adding five packages to the root manifest for a lint step.
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `require.resolve` returns the real path of the CLI's entry point inside
// pnpm's virtual store, where its dependencies sit beside it. A `require`
// created from there resolves them the same way the CLI itself does.
const cliEntry = createRequire(import.meta.url).resolve('@changesets/cli');
const cliRequire = createRequire(cliEntry);

const assembleReleasePlan = cliRequire(
  '@changesets/assemble-release-plan'
).default;
const { read: readConfig } = cliRequire('@changesets/config');
const { readPreState } = cliRequire('@changesets/pre');
const readChangesets = cliRequire('@changesets/read').default;
const { getPackages } = cliRequire('@manypkg/get-packages');

const packages = await getPackages(cwd);
const config = await readConfig(cwd, packages);
const [changesets, preState] = await Promise.all([
  readChangesets(cwd),
  readPreState(cwd),
]);

let plan;
try {
  plan = assembleReleasePlan(changesets, packages, config, preState);
} catch (error) {
  console.error(
    '✗ The pending changesets cannot be turned into a release plan.'
  );
  console.error('  `changeset version` will fail on main with this error:\n');
  console.error(
    String(error?.message ?? error)
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n')
  );
  console.error(
    '\n  A changeset may only list packages that are published, and never one from the `ignore` array in .changeset/config.json.'
  );
  process.exit(1);
}

const pending = plan.changesets.length;
const releasing = plan.releases.filter((r) => r.type !== 'none').length;
console.log(
  `✓ ${changesets.length} changeset(s) read, ${pending} pending${preState ? ` (${preState.mode} mode, tag "${preState.tag}")` : ''}; ${releasing} package(s) would be released.`
);
