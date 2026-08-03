#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function parseMajor(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  return match ? Number(match[1]) : null;
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function matchesIgnorePattern(name, pattern) {
  if (!pattern.includes('*')) {
    return name === pattern;
  }

  const regex = new RegExp(
    `^${pattern.split('*').map(escapeRegExp).join('.*')}$`
  );
  return regex.test(name);
}

function isIgnoredPackage(name, ignorePatterns) {
  return ignorePatterns.some((pattern) => matchesIgnorePattern(name, pattern));
}

function findPackagesOutsideReleaseMajor({
  packages,
  releaseVersion,
  ignorePatterns = [],
}) {
  const mismatches = [];

  for (const pkg of packages) {
    if (pkg.private || isIgnoredPackage(pkg.name, ignorePatterns)) {
      continue;
    }

    const major = parseMajor(pkg.version);
    if (major === releaseVersion) {
      continue;
    }

    mismatches.push({
      name: pkg.name,
      path: pkg.path,
      version: pkg.version,
    });
  }

  return mismatches.sort((a, b) => a.name.localeCompare(b.name));
}

function readPackageJson(filePath, rootDir) {
  const packageJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const relativePath = path
    .relative(rootDir, filePath)
    .split(path.sep)
    .join('/');

  return {
    name: packageJson.name ?? relativePath,
    path: relativePath,
    private: packageJson.private === true,
    version: packageJson.version,
  };
}

function readWorkspacePackages(rootDir = process.cwd()) {
  const packagesDir = path.join(rootDir, 'packages');

  return fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => path.join(packagesDir, dirent.name, 'package.json'))
    .filter((packageJsonPath) => fs.existsSync(packageJsonPath))
    .map((packageJsonPath) => readPackageJson(packageJsonPath, rootDir));
}

function readChangesetIgnorePatterns(rootDir = process.cwd()) {
  const configPath = path.join(rootDir, '.changeset', 'config.json');
  if (!fs.existsSync(configPath)) {
    return [];
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return Array.isArray(config.ignore) ? config.ignore : [];
}

function renderMarkdownSummary({ mismatches, releaseVersion }) {
  if (mismatches.length === 0) {
    return `### Major Version Guard\n\nAll public workspace package versions match release major \`${releaseVersion}\`.\n`;
  }

  const rows = mismatches
    .map(
      (mismatch) =>
        `| \`${mismatch.name}\` | \`${mismatch.version}\` | \`${mismatch.path}\` |`
    )
    .join('\n');

  return [
    '### Major Version Guard',
    '',
    `Failing because these public workspace package versions do not match release major \`${releaseVersion}\`.`,
    '',
    '| Package | Version | Path |',
    '| --- | --- | --- |',
    rows,
    '',
  ].join('\n');
}

function writeStepSummary(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}

function parseArgs(argv) {
  const [releaseVersionArg] = argv;
  if (argv.length > 1) {
    throw new Error(
      'Usage: check-release-major.js [release-version]\nSet RELEASE_VERSION when no argument is provided.'
    );
  }

  const releaseVersion = Number(
    releaseVersionArg ?? process.env.RELEASE_VERSION
  );
  if (!Number.isInteger(releaseVersion) || releaseVersion < 0) {
    throw new Error(
      'RELEASE_VERSION must be set to a non-negative integer release major.'
    );
  }

  return { releaseVersion };
}

function main() {
  const { releaseVersion } = parseArgs(process.argv.slice(2));
  const mismatches = findPackagesOutsideReleaseMajor({
    ignorePatterns: readChangesetIgnorePatterns(),
    packages: readWorkspacePackages(),
    releaseVersion,
  });
  const summary = renderMarkdownSummary({ mismatches, releaseVersion });

  process.stdout.write(summary);
  writeStepSummary(summary);

  if (mismatches.length > 0) {
    process.exit(1);
  }
}

module.exports = {
  findPackagesOutsideReleaseMajor,
  isIgnoredPackage,
  parseArgs,
  parseMajor,
  renderMarkdownSummary,
  readChangesetIgnorePatterns,
  readWorkspacePackages,
};

if (require.main === module) {
  main();
}
