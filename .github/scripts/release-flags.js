#!/usr/bin/env node

// Derives the `gh release create|edit` flags for a publish. Two decisions, and
// they are not the same decision:
//
//   --prerelease  follows the version. `5.1.0-beta.1` is a prerelease wherever
//                 it was cut; `5.0.0` is not, even on a maintenance branch.
//   --latest      follows the branch. GitHub's "Latest" marker belongs to the
//                 current GA line, which lives on `main`. Maintenance branches
//                 publish GA versions too and must never claim it.
//
// This lived inline in `.github/workflows/release.yml` as two shell `if`s,
// where it was unreachable from any test and only exercised by cutting a real
// release.

// The tag comes from `scripts/generate-release-notes.mjs`, which always emits
// `workflow@<version>` read from `packages/workflow/package.json`. Scoped names
// mean the separator we want is the *last* `@`, not the first.
function versionFromTag(tag) {
  const at = String(tag ?? '').lastIndexOf('@');
  return at > 0 ? tag.slice(at + 1) : '';
}

function isPrereleaseVersion(version) {
  // Prerelease is the `-` segment only. Build metadata (`+...`) may itself
  // contain a `-`, which is why this is a parse and not an indexOf.
  const match =
    /^\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) {
    return null;
  }
  return match[1] !== undefined;
}

function releaseFlags({ tag, refName }) {
  const version = versionFromTag(tag);
  const prerelease = isPrereleaseVersion(version);

  if (prerelease === null) {
    throw new Error(
      `Could not read a semver version out of release tag ${JSON.stringify(tag)}. ` +
        'Expected `workflow@<version>` from scripts/generate-release-notes.mjs.'
    );
  }

  return {
    prerelease,
    // Written as a whole flag rather than a boolean because `gh release` wants
    // `--latest` / `--latest=false`, and a bare `--latest=true` is not the same
    // as omitting it.
    latestFlag:
      !prerelease && refName === 'main' ? '--latest' : '--latest=false',
    version,
  };
}

function parseArgs(argv) {
  const [tag, refName] = argv;

  if (!tag || !refName) {
    throw new Error('Usage: release-flags.js <tag> <ref-name>');
  }

  return { refName, tag };
}

function main() {
  const { refName, tag } = parseArgs(process.argv.slice(2));
  const { latestFlag, prerelease } = releaseFlags({ refName, tag });

  process.stdout.write(`${JSON.stringify({ latestFlag, prerelease })}\n`);
}

module.exports = {
  isPrereleaseVersion,
  parseArgs,
  releaseFlags,
  versionFromTag,
};

if (require.main === module) {
  main();
}
