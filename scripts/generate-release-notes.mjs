#!/usr/bin/env node

/**
 * This script generates consolidated release notes for GitHub releases.
 * It aggregates changes from all package CHANGELOGs into a single release note
 * for the main `workflow` package.
 *
 * Usage: node scripts/generate-release-notes.mjs
 *
 * A package is included when its version differs from the one it had at the
 * previous `workflow` release tag on the same major line, so the notes cover the
 * whole release however many Release runs it took to publish. A run that
 * publishes only part of a release (a registry error stops `changeset publish`
 * partway) leaves the rest to a later run, and that later run is the one that
 * writes the GitHub release. Without a previous tag (a shallow clone, or the
 * first release on a line) every package's latest CHANGELOG entry is included.
 *
 * Output: JSON with { tag, title, body } for the GitHub release
 *
 * Example output:
 *
 *   {
 *     "tag": "workflow@4.0.1-beta.46",
 *     "title": "workflow@4.0.1-beta.46",
 *     "body": """
 *              ## @workflow/core@4.0.1-beta.46
 *              - [#123](https://github.com/vercel/workflow/pull/123) [`abc1234`](https://github.com/vercel/workflow/commit/abc1234) @someone - Fix thing
 *              ## @workflow/cli@4.0.1-beta.46
 *              - [`def5678`](https://github.com/vercel/workflow/commit/def5678) - Improve other thing"
 *             """
 *   }
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GITHUB_REPO = 'vercel/workflow';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ROOT_DIR = join(__dirname, '..');
const PACKAGES_DIR = join(ROOT_DIR, 'packages');

// Packages to include in the release notes (in order of importance)
// It's fine if a package isn't listed here, it will be sorted alphabetically.
const PACKAGE_ORDER = [
  'core',
  'cli',
  'workflow',
  'world',
  'world-local',
  'world-postgres',
  'world-vercel',
  'world-testing',
  'web',
  'web-shared',
  'ai',
  'typescript-plugin',
  'swc-plugin-workflow',
  'builders',
  'next',
  'nitro',
  'nuxt',
  'sveltekit',
  'astro',
  'vite',
  'rollup',
  'errors',
  'utils',
];

// Packages to exclude from release notes (internal/example packages)
const EXCLUDED_PACKAGES = ['tsconfig', 'example'];

/**
 * Parse a CHANGELOG.md file and extract the latest version's changes
 */
function parseChangelog(changelogPath) {
  if (!existsSync(changelogPath)) {
    return null;
  }

  const content = readFileSync(changelogPath, 'utf-8');
  const lines = content.split('\n');

  let packageName = null;
  let currentVersion = null;
  let changes = [];
  let inLatestVersion = false;
  let currentChange = '';

  for (const line of lines) {
    // Package name header (e.g., "# @workflow/core" or "# workflow")
    if (line.startsWith('# ') && !line.startsWith('## ')) {
      packageName = line.slice(2).trim();
      continue;
    }

    // Version header (e.g., "## 4.0.1-beta.27")
    if (line.startsWith('## ')) {
      if (inLatestVersion) {
        // We've hit the next version, stop parsing
        break;
      }
      currentVersion = line.slice(3).trim();
      inLatestVersion = true;
      continue;
    }

    if (!inLatestVersion) continue;

    // Skip section headers like "### Patch Changes"
    if (line.startsWith('### ')) continue;

    // Skip "Updated dependencies" lines - these are just internal dep bumps
    if (line.includes('Updated dependencies')) continue;

    // Skip lines that are just package version bumps (e.g., "- @workflow/core@4.0.1-beta.27")
    if (line.match(/^-\s+@?workflow\/[\w-]+@[\d.]+/)) continue;
    if (line.match(/^\s+-\s+@?workflow\/[\w-]+@[\d.]+/)) continue;

    // Actual change entry - starts with "- " and contains PR/commit info or description
    if (line.startsWith('- ')) {
      // Save previous change if exists
      if (currentChange) {
        changes.push(currentChange.trim());
      }
      currentChange = line.slice(2);
    } else if (currentChange && line.trim()) {
      // Continuation of previous change (multi-line description)
      currentChange += ` ${line.trim()}`;
    } else if (!line.trim() && currentChange) {
      // Empty line ends the current change
      changes.push(currentChange.trim());
      currentChange = '';
    }
  }

  // Don't forget the last change
  if (currentChange) {
    changes.push(currentChange.trim());
  }

  // Filter out empty changes and pure dependency updates
  changes = changes.filter((change) => {
    if (!change) return false;
    // Filter out pure dependency update entries
    if (change.match(/^@?workflow\/[\w-]+@[\d.]+/)) return false;
    return true;
  });

  if (!packageName || !currentVersion || changes.length === 0) {
    return null;
  }

  return {
    packageName,
    version: currentVersion,
    changes,
  };
}

// Cache for PR lookups to avoid duplicate API calls
const prCache = new Map();

/**
 * Look up PR information for a commit hash using GitHub CLI
 * Returns { number, user } or null if not found
 */
function lookupPRForCommit(commitHash) {
  if (prCache.has(commitHash)) {
    return prCache.get(commitHash);
  }

  try {
    const result = execSync(
      `gh api repos/${GITHUB_REPO}/commits/${commitHash}/pulls --jq '.[0] | {number: .number, user: .user.login}'`,
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (result && result !== 'null') {
      const pr = JSON.parse(result);
      prCache.set(commitHash, pr);
      return pr;
    }
  } catch {
    // Silently fail - PR lookup is best-effort
  }

  prCache.set(commitHash, null);
  return null;
}

/**
 * Format a single change entry for the release notes
 * Input format: [#541](url) [`hash`](url) Thanks [@user](url)! - description
 * OR: hash: description (for entries without PR links)
 * Output format: - [#541](url) [`hash`](url) [@user](url) - description
 */
function formatChange(change) {
  // Check if this is a commit-only entry (format: "hash: description")
  const commitOnlyMatch = change.match(/^([a-f0-9]{7,40}):\s*(.+)$/i);
  if (commitOnlyMatch) {
    const [, commitHash, description] = commitOnlyMatch;
    const pr = lookupPRForCommit(commitHash);

    if (pr) {
      // Format with PR link
      return `- [#${pr.number}](https://github.com/${GITHUB_REPO}/pull/${pr.number}) [\`${commitHash}\`](https://github.com/${GITHUB_REPO}/commit/${commitHash}) @${pr.user} - ${description}`;
    } else {
      // No PR found, just format with commit link
      return `- [\`${commitHash}\`](https://github.com/${GITHUB_REPO}/commit/${commitHash}) - ${description}`;
    }
  }

  // Regular format with PR links already present
  // Remove "Thanks " prefix if present
  let formatted = change.replace(/Thanks\s+/g, '');
  // Remove trailing "!" before the dash
  formatted = formatted.replace(/!\s*-\s*/, ' - ');
  return `- ${formatted}`;
}

/**
 * Get the main workflow package version
 */
function getWorkflowVersion() {
  const packageJsonPath = join(PACKAGES_DIR, 'workflow', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  return packageJson.version;
}

/**
 * Compare two semver strings (`5.2.1`, `5.0.0-beta.48`). Returns a negative
 * number, zero or a positive number, like a sort comparator.
 */
function compareVersions(a, b) {
  const [aCore, aPre] = a.split('-', 2);
  const [bCore, bPre] = b.split('-', 2);
  const aParts = aCore.split('.').map(Number);
  const bParts = bCore.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (aParts[i] !== bParts[i]) return aParts[i] - bParts[i];
  }
  if (aPre === bPre) return 0;
  // A prerelease sorts before its release.
  if (aPre === undefined) return 1;
  if (bPre === undefined) return -1;
  const aIds = aPre.split('.');
  const bIds = bPre.split('.');
  for (let i = 0; i < Math.max(aIds.length, bIds.length); i++) {
    if (aIds[i] === undefined) return -1;
    if (bIds[i] === undefined) return 1;
    if (aIds[i] === bIds[i]) continue;
    const aNum = /^\d+$/.test(aIds[i]);
    const bNum = /^\d+$/.test(bIds[i]);
    if (aNum && bNum) return Number(aIds[i]) - Number(bIds[i]);
    if (aNum) return -1;
    if (bNum) return 1;
    return aIds[i] < bIds[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Find the tag of the previous `workflow` release on the current major line:
 * the highest `workflow@<major>.*` version below the current one. This goes by
 * version, not by ancestry, because a release can be published from a commit
 * that is not on the branch (5.2.0 was published from its release PR's head).
 */
function getPreviousReleaseTag(workflowVersion) {
  const major = workflowVersion.split('.')[0];
  let tags;
  try {
    tags = execSync(`git tag --list 'workflow@${major}.*'`, {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
  let previous = null;
  for (const tag of tags) {
    const version = tag.slice('workflow@'.length);
    if (compareVersions(version, workflowVersion) >= 0) continue;
    if (!previous || compareVersions(version, previous) > 0) {
      previous = version;
    }
  }
  return previous ? `workflow@${previous}` : null;
}

/**
 * Read a package's version at a git ref, or null if it did not exist there.
 */
function getVersionAtRef(ref, packageDir) {
  try {
    const content = execSync(
      `git show '${ref}:packages/${packageDir}/package.json'`,
      { cwd: ROOT_DIR, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(content).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Main function to generate release notes
 */
function generateReleaseNotes() {
  const workflowVersion = getWorkflowVersion();
  const previousTag = getPreviousReleaseTag(workflowVersion);

  // Collect changes from all packages
  const packageChanges = [];

  // Get all package directories
  const packageDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .filter((name) => !EXCLUDED_PACKAGES.some((ex) => name.includes(ex)));

  // Sort packages by defined order, then alphabetically for unknown packages
  packageDirs.sort((a, b) => {
    const aIndex = PACKAGE_ORDER.indexOf(a);
    const bIndex = PACKAGE_ORDER.indexOf(b);
    if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  });

  for (const packageDir of packageDirs) {
    const changelogPath = join(PACKAGES_DIR, packageDir, 'CHANGELOG.md');
    const parsed = parseChangelog(changelogPath);

    if (parsed && parsed.changes.length > 0) {
      // A package whose version is unchanged since the previous release would
      // repeat that release's notes.
      if (
        previousTag &&
        getVersionAtRef(previousTag, packageDir) === parsed.version
      ) {
        continue;
      }
      packageChanges.push(parsed);
    }
  }

  // Build the release body
  let body = '';

  for (const pkg of packageChanges) {
    // Skip the main workflow package - it usually only has dependency updates
    if (pkg.packageName === 'workflow') continue;

    body += `## ${pkg.packageName}@${pkg.version}\n\n`;
    for (const change of pkg.changes) {
      body += `${formatChange(change)}\n`;
    }
    body += '\n';
  }

  // Trim trailing whitespace
  body = body.trim();

  // If no changes, add a note
  if (!body) {
    body =
      'This release contains dependency updates and internal improvements.';
  }

  const result = {
    tag: `workflow@${workflowVersion}`,
    title: `workflow@${workflowVersion}`,
    body,
  };

  console.log(JSON.stringify(result, null, 2));
}

generateReleaseNotes();
