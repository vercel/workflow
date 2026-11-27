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
 * It also enforces one versioning rule of this repo: `workflow` only takes a
 * minor (or major) release when `@workflow/core` does. `workflow` is in a
 * fixed group with `@workflow/core` and `@workflow/world-vercel`, so a
 * changeset that bumps any member of that group bumps all three by the same
 * type. Changes to the packages `workflow` depends on (`@workflow/cli`,
 * `@workflow/next`, `@workflow/web-shared`, the worlds, ...) already reach it
 * as a patch through the dependency graph; only a changeset that lists
 * `workflow` or `@workflow/world-vercel` itself at `minor` can make the whole
 * SDK a minor release for a change core does not ship. Such a changeset has
 * to list `@workflow/core` at the same bump, or use `patch` for the others.
 *
 * The libraries are the same ones `@changesets/cli` uses, declared as root
 * devDependencies at the ranges the CLI itself declares, so this check cannot
 * drift from what the Release job will do.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleReleasePlan } from '@changesets/assemble-release-plan';
import { readConfig } from '@changesets/config';
import { readPreState } from '@changesets/pre';
import { readChangesets } from '@changesets/read';
import { getPackages } from '@manypkg/get-packages';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const packages = await getPackages(cwd);
const {
  config,
  errors: configErrors,
  warnings: configWarnings,
} = await readConfig(cwd, packages);
for (const warning of configWarnings ?? [])
  console.warn(`! .changeset/config.json: ${warning}`);
if (configErrors) {
  console.error('✗ .changeset/config.json is invalid:');
  for (const error of configErrors) console.error(`    ${error}`);
  process.exit(1);
}
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

// Members of @workflow/core's fixed group, other than core itself, may not
// raise the group's bump above the one core takes in the same changeset.
const RANK = { none: 0, patch: 1, minor: 2, major: 3 };
const CORE = '@workflow/core';
const coreGroup = (config.fixed ?? []).find((group) => group.includes(CORE));
const violations = [];
for (const changeset of changesets) {
  const coreType =
    changeset.releases.find((r) => r.name === CORE)?.type ?? 'none';
  for (const release of changeset.releases) {
    if (release.name === CORE || !coreGroup?.includes(release.name)) continue;
    if (RANK[release.type] >= RANK.minor && RANK[release.type] > RANK[coreType])
      violations.push(
        `.changeset/${changeset.id}.md: "${release.name}": ${release.type} (with "${CORE}": ${coreType})`
      );
  }
}
if (violations.length > 0) {
  console.error(
    `✗ A changeset would make \`workflow\` a minor or major release without \`${CORE}\` taking that bump:\n`
  );
  for (const violation of violations) console.error(`    ${violation}`);
  console.error(
    `\n  \`${coreGroup.join('`, `')}\` share one version, so this bumps all of them. Use \`patch\` for ${coreGroup
      .filter((name) => name !== CORE)
      .map((name) => `\`${name}\``)
      .join(
        ' and '
      )} unless \`${CORE}\` itself ships the feature, and then list \`${CORE}\` at the same bump.`
  );
  process.exit(1);
}

const pending = plan.changesets.length;
const releasing = plan.releases.filter((r) => r.type !== 'none').length;
console.log(
  `✓ ${changesets.length} changeset(s) read, ${pending} pending${preState ? ` (${preState.mode} mode, tag "${preState.tag}")` : ''}; ${releasing} package(s) would be released.`
);
