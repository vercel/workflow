#!/usr/bin/env node
/**
 * Fails when a publishable package would ship files no consumer reads.
 *
 * Every package's `files` list decides what lands in `node_modules` for each
 * app that installs `workflow`. Compiled tests and declaration maps add up:
 * before the exclusions below, `@workflow/builders` shipped 72 compiled tests
 * and `@workflow/cli` 60, and `@workflow/world` had no `files` list at all,
 * so it published `src/`, its tests and its `tsconfig.json`.
 *
 * For every non-private package under `packages/`:
 *
 *   - `files` must be set, so npm does not fall back to publishing everything;
 *   - a published `dist` must exclude `dist/**\/*.test.*`;
 *   - a published `dist` must exclude `dist/**\/*.d.ts.map`, unless `src` is
 *     published too: those maps point at `../src`, so they only resolve when
 *     the sources ship alongside them;
 *   - a published `src` must exclude `src/**\/*.test.*`.
 *
 * The check reads manifests only, so it needs no build and runs in seconds.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');

const problems = [];

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(packagesDir, entry.name, 'package.json'), 'utf8')
    );
  } catch {
    continue;
  }
  if (manifest.private) continue;

  const name = manifest.name ?? entry.name;
  const files = manifest.files;
  if (!Array.isArray(files) || files.length === 0) {
    problems.push(`${name}: set "files" so npm does not publish everything`);
    continue;
  }

  const has = (pattern) => files.includes(pattern);
  const shipsDist = has('dist');
  const shipsSrc = has('src');

  if (shipsDist && !has('!dist/**/*.test.*')) {
    problems.push(`${name}: add "!dist/**/*.test.*" to "files"`);
  }
  if (shipsDist && !shipsSrc && !has('!dist/**/*.d.ts.map')) {
    problems.push(
      `${name}: add "!dist/**/*.d.ts.map" to "files" (its maps point at the unpublished src/)`
    );
  }
  if (shipsSrc && !has('!src/**/*.test.*')) {
    problems.push(`${name}: add "!src/**/*.test.*" to "files"`);
  }
}

if (problems.length > 0) {
  console.error('Published files check failed:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('✓ Every publishable package excludes tests and orphaned maps');
