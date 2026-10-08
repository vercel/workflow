#!/usr/bin/env node
/**
 * Lists the publishable package versions on this commit that are not on npm.
 *
 * `changesets/action` publishes only when no changesets are pending. A
 * "Version Packages" PR merged without every pending changeset (because the
 * run that should have refreshed it failed, or because a newer push cancelled
 * the release PR's own queued run) therefore strands the versions it bumped:
 * every later run sees the leftover changeset and only versions. The Release
 * job runs this script first, and when it lists anything the job sets the
 * pending changesets aside so the action publishes them.
 *
 * Only the version list is checked, not the `previous` dist-tag: packages that
 * have not been released since 4.x moved to `previous` have no such tag.
 *
 * Manifests are read from the commit (`git show HEAD:...`), not the working
 * tree. Writes `missing=<name@version ...>` to `$GITHUB_OUTPUT` when set.
 *
 * Usage: node scripts/find-unpublished-versions.mjs [--ref <git-ref>]
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.npmjs.org';

const refIndex = process.argv.indexOf('--ref');
const REF = refIndex !== -1 ? process.argv[refIndex + 1] : 'HEAD';

function git(args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readJsonAtRef(path) {
  return JSON.parse(git(['show', `${REF}:${path}`]));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function publishablePackages() {
  const { ignore = [] } = readJsonAtRef('.changeset/config.json');
  const ignored = ignore.map(
    (glob) => new RegExp(`^${glob.split('*').map(escapeRegExp).join('.*')}$`)
  );
  return git(['ls-tree', '-r', '--name-only', REF, '--', 'packages/'])
    .split('\n')
    .filter((path) => /^packages\/[^/]+\/package\.json$/.test(path))
    .map(readJsonAtRef)
    .filter((manifest) => manifest.name && manifest.version)
    .filter((manifest) => !manifest.private)
    .filter((manifest) => !ignored.some((re) => re.test(manifest.name)))
    .map(({ name, version }) => ({ name, version }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function isOnNpm({ name, version }) {
  const url = `${REGISTRY}/${name.replace('/', '%2F')}`;
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(
      `GET ${url} failed: ${response.status} ${response.statusText}`
    );
  }
  const doc = await response.json();
  return Object.hasOwn(doc.versions ?? {}, version);
}

const packages = publishablePackages();
const published = await Promise.all(packages.map(isOnNpm));
const missing = packages
  .filter((_, i) => !published[i])
  .map(({ name, version }) => `${name}@${version}`);

if (missing.length === 0) {
  console.log(`All ${packages.length} publishable versions are on npm.`);
} else {
  console.log(`${missing.length} version(s) on this commit are not on npm:`);
  for (const id of missing) console.log(`    ${id}`);
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `missing=${missing.join(' ')}\n`);
}
