#!/usr/bin/env node

/**
 * This script generates consolidated release notes for GitHub releases.
 * It aggregates changes from all package CHANGELOGs into a single release note
 * for the main `workflow` package.
 *
 * Usage: node scripts/generate-release-notes.mjs
 *
 * Output: JSON with { tag, title, body } for the GitHub release
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
      currentChange += ' ' + line.trim();
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
 * Main function to generate release notes
 */
function generateReleaseNotes() {
  const workflowVersion = getWorkflowVersion();

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
