#!/usr/bin/env node

/**
 * Generates a GitHub Actions matrix for community world testing.
 * Reads from worlds-manifest.json and filters to testable community worlds.
 *
 * Usage: node scripts/create-community-worlds-matrix.mjs
 *
 * Output format (JSON):
 * {
 *   "world": [
 *     {
 *       "id": "starter",
 *       "name": "Starter",
 *       "package": "@workflow-worlds/starter",
 *       "service-type": "none",
 *       "env-vars": "{\"WORKFLOW_TARGET_WORLD\":\"@workflow-worlds/starter\"}",
 *       "setup-command": "",
 *       "test-name-pattern": ""
 *     },
 *     ...
 *   ]
 * }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Read the manifest
const manifestPath = path.join(rootDir, 'worlds-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

const e2eTestPath = path.join(rootDir, 'packages/core/e2e/e2e.test.ts');

/**
 * Parts of the World contract a published community world is known not to
 * implement, mapped to the E2E tests that cannot finish without them. A world
 * names its gaps in `knownGaps` in worlds-manifest.json.
 *
 * Only tests that would sit until their own deadline belong here: the run they
 * wait on is never woken, so each one costs its full 60-120s timeout and the
 * lane overruns its job timeout before it can report anything. Tests a gap
 * makes fail outright stay in the suite and show up as failures.
 *
 * Each entry is a fragment of a test's title in packages/core/e2e/e2e.test.ts,
 * checked against that file by `checkFragmentsNameTests`. Fragments are joined
 * into a regular expression, so keep them to letters, digits, spaces and
 * hyphens.
 */
const TESTS_BLOCKED_BY_GAP = {
  // The flow handler returns `{ timeoutSeconds: 0 }` to be invoked again at
  // once (after a hook conflict, an awaited hook creation, or a step whose
  // arguments failed to serialize). A queue that treats 0 as "no retry"
  // acknowledges the message instead, and the run stays `running` for good.
  'zero-delay-redelivery': [
    'step-argument serialization failure',
    'concurrent hook token conflict - two workflows cannot use the same hook token',
    'registers hook without payload',
    'resolves with the conflicting run when token is already registered',
    'hookClaimOnlyMutexWorkflow - hook works as a pure run mutex',
    'hookAdoptOwnerResultWorkflow - duplicate adopts the owner result',
    'hookSignalOwnerWorkflow - duplicate forwards its payload to the owner',
    'hookSupersedeOwnerWorkflow - duplicate cancels the owner and claims the released token',
  ],
  // These tests read a run's stream from the test process while the app
  // process is still writing it. A streamer that only notifies readers in the
  // writing process never delivers those chunks, or the close, to the test.
  'cross-process-streams': [
    'no startIndex',
    'outputStreamInsideStepWorkflow - getWritable',
    'writableForwardedFrom',
  ],
};

/**
 * The single-line string literals of the E2E suite outside comments, which
 * include every test title.
 */
function e2eStringLiterals() {
  const literals = [];
  for (const line of fs.readFileSync(e2eTestPath, 'utf-8').split('\n')) {
    if (/^\s*(\/\/|\/?\*)/.test(line)) continue;
    for (const match of line.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)) {
      literals.push(match[1] ?? match[2] ?? match[3]);
    }
  }
  return literals;
}

/**
 * Warns when a fragment no longer names a test. A renamed test would otherwise
 * drop out of the pattern unnoticed and run to its deadline again. It is a
 * warning on stderr, not an error: stdout carries the matrix, and the benchmark
 * workflow builds its matrix with this script too, so a test rename must not
 * fail either job.
 */
function checkFragmentsNameTests() {
  const literals = e2eStringLiterals();
  for (const [gap, fragments] of Object.entries(TESTS_BLOCKED_BY_GAP)) {
    for (const fragment of fragments) {
      if (!/^[A-Za-z0-9 -]+$/.test(fragment)) {
        throw new Error(
          `Test name fragment "${fragment}" must contain only letters, digits, spaces and hyphens`
        );
      }
      if (!literals.some((literal) => literal.includes(fragment))) {
        console.warn(
          `::warning file=scripts/create-community-worlds-matrix.mjs::Gap "${gap}" lists ` +
            `"${fragment}", which matches no test title in ` +
            `${path.relative(rootDir, e2eTestPath)}. Update TESTS_BLOCKED_BY_GAP ` +
            `to the test's current title.`
        );
      }
    }
  }
}

/**
 * Builds the vitest `--testNamePattern` that leaves out every test blocked by
 * one of the world's known gaps, or an empty string when there are none.
 * Vitest reports the tests the pattern rejects as skipped.
 */
function testNamePatternFor(world) {
  const fragments = (world.knownGaps || []).flatMap((gap) => {
    const tests = TESTS_BLOCKED_BY_GAP[gap];
    if (!tests) {
      throw new Error(
        `worlds-manifest.json: world "${world.id}" names unknown gap "${gap}". ` +
          `Known gaps: ${Object.keys(TESTS_BLOCKED_BY_GAP).join(', ')}`
      );
    }
    return tests;
  });
  return fragments.length > 0 ? `^(?!.*(?:${fragments.join('|')}))` : '';
}

checkFragmentsNameTests();

// Filter to community worlds that can be tested in CI
const testableWorlds = manifest.worlds.filter((world) => {
  // Only community worlds
  if (world.type !== 'community') return false;

  // Skip worlds that require external credentials (e.g., Jazz needs API keys)
  if (world.requiresCredentials) return false;

  return true;
});

// Build the matrix
const matrix = {
  world: testableWorlds.map((world) => {
    // Determine service type based on services array
    let serviceType = 'none';
    if (world.services && world.services.length > 0) {
      // Use the first service's name as the service type
      // Currently supports: mongodb, redis
      const serviceName = world.services[0].name;
      if (['mongodb', 'redis'].includes(serviceName)) {
        serviceType = serviceName;
      }
    }

    return {
      id: world.id,
      name: world.name,
      package: world.package,
      'service-type': serviceType,
      'env-vars': JSON.stringify(world.env || {}),
      'setup-command': world.setup || '',
      'test-name-pattern': testNamePatternFor(world),
    };
  }),
};

// Output JSON for GitHub Actions
console.log(JSON.stringify(matrix));
