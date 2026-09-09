#!/usr/bin/env node
/**
 * Fails when a publishable package version on this commit is not on npm.
 *
 * `changeset publish` runs one `pnpm publish` per package, concurrently, and
 * reports the release as a whole. When one of those publishes fails the
 * release is left half-shipped: some versions are live, others are not, and
 * `workflow` can point at an `@workflow/core` that does not exist yet. The
 * 5.0.0-beta.48 release shipped 7 of 21 packages on its first attempt, and
 * the failure that stopped it (an E401 whose JSON had no `detail` field)
 * crashed the publish loop before it printed which packages were affected.
 *
 * This script is the check the Release job runs after publishing, whatever
 * the publish step's outcome: every non-private package that changesets does
 * not ignore must have its manifest version in the registry's version list,
 * and the branch's dist-tag (the pre-release tag from `.changeset/pre.json`
 * while in pre mode, `latest` otherwise) must point at it. The invariant
 * holds on every commit of a release branch, not only right after a publish,
 * so a gap keeps failing the job until it is closed.
 *
 * The registry can lag a publish by a few seconds, so missing versions are
 * re-checked a few times before they are reported.
 *
 * Usage: node scripts/check-published.mjs [--tag <dist-tag>]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.npmjs.org';
const ATTEMPTS = Number(process.env.CHECK_PUBLISHED_ATTEMPTS ?? 6);
const DELAY_MS = Number(process.env.CHECK_PUBLISHED_DELAY_MS ?? 10_000);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function distTagForBranch() {
  const argIndex = process.argv.indexOf('--tag');
  if (argIndex !== -1 && process.argv[argIndex + 1]) {
    return process.argv[argIndex + 1];
  }
  const prePath = join(root, '.changeset', 'pre.json');
  if (existsSync(prePath)) {
    const pre = readJson(prePath);
    if (pre.mode === 'pre' && pre.tag) return pre.tag;
  }
  return 'latest';
}

function publishablePackages() {
  const { ignore = [] } = readJson(join(root, '.changeset', 'config.json'));
  const ignored = new Set(ignore.filter((name) => !name.includes('*')));
  const ignoredPatterns = ignore
    .filter((name) => name.includes('*'))
    .map(
      (glob) => new RegExp(`^${glob.split('*').map(escapeRegExp).join('.*')}$`)
    );
  const packagesDir = join(root, 'packages');
  const result = [];
  for (const dir of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    if (!manifest.name || !manifest.version || manifest.private) continue;
    if (ignored.has(manifest.name)) continue;
    if (ignoredPatterns.some((re) => re.test(manifest.name))) continue;
    result.push({ name: manifest.name, version: manifest.version });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function registryState(name) {
  const url = `${REGISTRY}/${name.replace('/', '%2F')}`;
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
  });
  if (response.status === 404) return { versions: {}, distTags: {} };
  if (!response.ok) {
    throw new Error(
      `GET ${url} failed: ${response.status} ${response.statusText}`
    );
  }
  const doc = await response.json();
  return { versions: doc.versions ?? {}, distTags: doc['dist-tags'] ?? {} };
}

async function check(pkg, tag) {
  const { versions, distTags } = await registryState(pkg.name);
  const visible = Object.hasOwn(versions, pkg.version);
  const tagged = distTags[tag] === pkg.version;
  return { ...pkg, visible, tagged, actualTag: distTags[tag] };
}

const tag = distTagForBranch();
const packages = publishablePackages();
let results = await Promise.all(packages.map((pkg) => check(pkg, tag)));

for (let attempt = 1; attempt < ATTEMPTS; attempt++) {
  const pending = results.filter((r) => !(r.visible && r.tagged));
  if (pending.length === 0) break;
  console.log(
    `${pending.length} package(s) not yet visible with the "${tag}" tag; re-checking in ${DELAY_MS / 1000}s (attempt ${attempt + 1}/${ATTEMPTS})...`
  );
  await new Promise((resolveDelay) => setTimeout(resolveDelay, DELAY_MS));
  const rechecked = await Promise.all(pending.map((r) => check(r, tag)));
  results = results.map((r) => rechecked.find((n) => n.name === r.name) ?? r);
}

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  const status = r.visible
    ? r.tagged
      ? 'ok'
      : `visible, but "${tag}" is ${r.actualTag ?? 'unset'}`
    : 'NOT ON NPM';
  console.log(`${r.name.padEnd(width)}  ${r.version.padEnd(14)}  ${status}`);
}

const missing = results.filter((r) => !r.visible);
const untagged = results.filter((r) => r.visible && !r.tagged);
if (missing.length === 0 && untagged.length === 0) {
  console.log(
    `\n✓ all ${results.length} publishable packages are on npm under the "${tag}" tag.`
  );
  process.exit(0);
}

console.error('');
if (missing.length > 0) {
  console.error(
    `✗ ${missing.length} package version(s) on this commit are not on npm:`
  );
  for (const r of missing) console.error(`    ${r.name}@${r.version}`);
  console.error(
    '\n  Read the publish step above for each one. If `pnpm publish` reported the\n' +
      '  version as "previously staged", it is waiting for a maintainer to approve it in\n' +
      "  the package's Staged Packages tab on npmjs.com. Otherwise re-run the Release\n" +
      '  workflow (workflow_dispatch); `changeset publish` skips versions already live.'
  );
}
if (untagged.length > 0) {
  console.error(
    `✗ ${untagged.length} package(s) are on npm but the "${tag}" dist-tag does not point at them:`
  );
  for (const r of untagged)
    console.error(
      `    ${r.name}@${r.version} (tag is ${r.actualTag ?? 'unset'})`
    );
}
process.exit(1);
