#!/usr/bin/env node
/**
 * Fails when a workspace test file is one nothing runs.
 *
 * The root `test` script is `turbo test`, which invokes each package's own
 * `test` script. A package that ships `*.test.ts` files but declares no `test`
 * script is therefore skipped in silence: the files look like coverage, and
 * the assertions inside them rot without anyone noticing. `@workflow/world`
 * sat that way with 13 files and 160 tests, long enough for one of them to
 * start asserting the wrong spec version (#3731). `@workflow/cli` and
 * `@workflow/nitro` were in the same state, as were two files under
 * `packages/core/e2e`.
 *
 * Every test file must therefore be reachable one of two ways:
 *
 *   1. Its package has a `test` script whose positional path filters cover
 *      the file, so `turbo test` runs it. Vitest treats positionals as
 *      filters, so `vitest run src` beside a test in `e2e/` drops that file
 *      quietly rather than reporting it as missing — hence the check.
 *   2. A CI workflow, or a root `package.json` script, names the file (or a
 *      directory containing it) explicitly. This is how the suites that need
 *      a live deployment or a built workbench app are run.
 *
 * Anything else is a suite nobody runs, and it fails this check.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Packages with no `test` script whose suites are run some other way, mapped
 * to the lane that runs them.
 *
 * Keep this short and specific: an entry here is a suite whose failures no
 * longer block a merge by default, so "we will wire it up later" is not a
 * reason. Rule 2 above already covers anything a workflow names directly.
 */
const WAIVERS = new Map([
  [
    '@workflow/docs-typecheck',
    'Typechecks every snippet under docs/ against the built packages, far too ' +
      'slow for the unit lane. Run as `pnpm test:docs` by the Docs Checks ' +
      'workflow.',
  ],
]);

/** Directories never worth walking into. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.turbo',
  '.vercel',
  'coverage',
]);

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Workspace roots to scan, mirroring pnpm-workspace.yaml. */
const WORKSPACE_ROOTS = ['packages', 'workbench', 'docs', 'tarballs'];

const toPosix = (p) => p.split(sep).join(posix.sep);

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Everything that could name a test file explicitly: the CI workflows and the
 * root package.json scripts. Concatenated and searched as plain text, which
 * is deliberate — a path is a path however the YAML around it is shaped, and
 * parsing the workflows would only add ways to miss one.
 */
function laneText() {
  const workflowsDir = join(repoRoot, '.github', 'workflows');
  let names = [];
  try {
    names = readdirSync(workflowsDir).filter((n) => /\.ya?ml$/.test(n));
  } catch {
    // No workflows directory: every file then has to be covered by rule 1.
  }
  return [
    ...names.map((n) => readIfPresent(join(workflowsDir, n))),
    readIfPresent(join(repoRoot, 'package.json')),
  ].join('\n');
}

function findTestFiles(dir, pkgDir, found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findTestFiles(full, pkgDir, found);
    } else if (TEST_FILE.test(entry.name)) {
      found.push(toPosix(relative(pkgDir, full)));
    }
  }
  return found;
}

/**
 * The positional path filters in a `test` script, or null when the script is
 * not a vitest invocation.
 *
 * Only the shapes this repo uses are understood: everything up to and
 * including the `vitest` binary is dropped (`cross-env FOO=bar vitest run
 * src`), as are flags. An empty array means "no filter", which covers the
 * whole package.
 */
function positionalFilters(script) {
  const tokens = script.split(/\s+/).filter(Boolean);
  const vitestAt = tokens.findIndex(
    (t) => t === 'vitest' || t.endsWith('/vitest')
  );
  if (vitestAt === -1) return null;
  return tokens
    .slice(vitestAt + 1)
    .filter((t) => t !== 'run' && !t.startsWith('-'));
}

/**
 * Is `path` named in `text` as a whole path, rather than as the head of a
 * longer one?
 *
 * The distinction is the whole point of the check: `packages/world` occurs in
 * every workflow that mentions `packages/world-vercel`, and a plain substring
 * search would read that as "some lane runs it" for any file under
 * packages/world. A trailing `/` counts as continuation for the same reason —
 * a lane naming `packages/core/e2e/local-build.test.ts` says nothing about
 * the other files in that directory.
 */
function namedIn(text, path) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_./-])`).test(
    text
  );
}

/** Does `filter` (a path prefix or an exact path) cover `file`? */
const covers = (filter, file) =>
  file === filter || file.startsWith(`${filter.replace(/\/$/, '')}/`);

function packageDirs() {
  const dirs = [];
  for (const root of WORKSPACE_ROOTS) {
    let entries;
    try {
      entries = readdirSync(join(repoRoot, root), { withFileTypes: true });
    } catch {
      continue;
    }
    // `docs` and `tarballs` are packages themselves, not directories of them.
    if (entries.some((e) => e.name === 'package.json')) {
      dirs.push(join(repoRoot, root));
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(join(repoRoot, root, entry.name));
    }
  }
  return dirs;
}

const lanes = laneText();
const problems = [];

for (const pkgDir of packageDirs()) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }

  const relPath = toPosix(relative(repoRoot, pkgDir));
  const name = pkg.name ?? relPath;
  const testFiles = findTestFiles(pkgDir, pkgDir);
  if (testFiles.length === 0 || WAIVERS.has(name)) continue;

  const script = pkg.scripts?.test;
  const filters = script ? positionalFilters(script) : null;
  // A vitest script with no positionals runs the whole package.
  const runsWholePackage = filters !== null && filters.length === 0;

  const orphans = runsWholePackage
    ? []
    : testFiles.filter((file) => {
        if (filters?.some((filter) => covers(filter, file))) return false;
        // Rule 2: some workflow or root script names the file, or a directory
        // holding it, outright.
        const fromRoot = `${relPath}/${file}`;
        for (let path = fromRoot; path.includes('/'); ) {
          if (namedIn(lanes, path)) return false;
          path = path.slice(0, path.lastIndexOf('/'));
        }
        return true;
      });

  if (orphans.length === 0) continue;

  const shown = orphans.slice(0, 8);
  const more =
    orphans.length > shown.length
      ? `\n    …and ${orphans.length - shown.length} more`
      : '';
  problems.push(
    script
      ? `${name} (${relPath}) has test file(s) that neither its "test" script ` +
          `(\`${script}\`) nor any CI workflow runs:\n    ${shown.join('\n    ')}${more}`
      : `${name} (${relPath}) has ${orphans.length} test file(s) but no "test" ` +
          'script, so `turbo test` skips the package entirely:\n    ' +
          shown.join('\n    ') +
          more
  );
}

if (problems.length > 0) {
  console.error('Test files that nothing runs:\n');
  for (const problem of problems) console.error(`  ✗ ${problem}\n`);
  console.error(
    'Fix by adding a "test" script to the package (usually `vitest run src`) so\n' +
      '`turbo test` picks it up, by widening an existing script to cover the files,\n' +
      'or — when a suite needs a deployment or a built app — by naming it in the CI\n' +
      'workflow step that runs it.'
  );
  process.exit(1);
}

console.log(
  '✓ Every workspace test file is run by `turbo test` or a named CI lane.'
);
