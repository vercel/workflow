const assert = require('node:assert');
const { test } = require('node:test');

const {
  findPackagesOutsideReleaseMajor,
  isIgnoredPackage,
  parseArgs,
  parseMajor,
  renderMarkdownSummary,
} = require('./check-release-major.js');

test('parseMajor reads stable and prerelease versions', () => {
  assert.strictEqual(parseMajor('4.5.0'), 4);
  assert.strictEqual(parseMajor('5.0.0-beta.17'), 5);
  assert.strictEqual(parseMajor('not-semver'), null);
});

test('isIgnoredPackage supports exact names and wildcard patterns', () => {
  assert.strictEqual(
    isIgnoredPackage('@workflow/docs-typecheck', [
      '@workflow/docs-typecheck',
      '@workflow/example-*',
    ]),
    true
  );
  assert.strictEqual(
    isIgnoredPackage('@workflow/example-nextjs', ['@workflow/example-*']),
    true
  );
  assert.strictEqual(
    isIgnoredPackage('@workflow/ai', ['@workflow/example-*']),
    false
  );
});

test('findPackagesOutsideReleaseMajor flags packages outside the configured release version', () => {
  const packages = [
    {
      name: '@workflow/ai',
      path: 'packages/ai/package.json',
      version: '7.0.0',
    },
    {
      name: '@workflow/core',
      path: 'packages/core/package.json',
      version: '5.0.0',
    },
    {
      name: 'workflow',
      path: 'packages/workflow/package.json',
      version: '5.0.0-beta.17',
    },
    {
      name: '@workflow/internal',
      path: 'packages/internal/package.json',
      private: true,
      version: '7.0.0',
    },
    {
      name: '@workflow/example-nextjs',
      path: 'packages/example-nextjs/package.json',
      version: '7.0.0',
    },
  ];

  assert.deepStrictEqual(
    findPackagesOutsideReleaseMajor({
      ignorePatterns: ['@workflow/example-*'],
      packages,
      releaseVersion: 5,
    }),
    [
      {
        name: '@workflow/ai',
        path: 'packages/ai/package.json',
        version: '7.0.0',
      },
    ]
  );
});

test('renderMarkdownSummary names the configured release version when blocked', () => {
  const summary = renderMarkdownSummary({
    releaseVersion: 5,
    mismatches: [
      {
        name: '@workflow/ai',
        path: 'packages/ai/package.json',
        version: '7.0.0',
      },
    ],
  });

  assert.match(summary, /release major `5`/);
  assert.match(summary, /@workflow\/ai/);
  assert.match(summary, /Failing/);
});

test('parseArgs reads release version from argv or environment', () => {
  assert.deepStrictEqual(parseArgs(['5']), {
    releaseVersion: 5,
  });

  const oldReleaseVersion = process.env.RELEASE_VERSION;
  process.env.RELEASE_VERSION = '4';
  assert.deepStrictEqual(parseArgs([]), {
    releaseVersion: 4,
  });

  if (oldReleaseVersion === undefined) {
    delete process.env.RELEASE_VERSION;
  } else {
    process.env.RELEASE_VERSION = oldReleaseVersion;
  }
});
