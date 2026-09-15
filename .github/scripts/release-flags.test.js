const assert = require('node:assert');
const { test } = require('node:test');

const {
  isPrereleaseVersion,
  parseArgs,
  releaseFlags,
  versionFromTag,
} = require('./release-flags.js');

test('versionFromTag splits on the last @ so scoped names survive', () => {
  assert.strictEqual(versionFromTag('workflow@5.0.0'), '5.0.0');
  assert.strictEqual(
    versionFromTag('@workflow/core@5.0.0-beta.51'),
    '5.0.0-beta.51'
  );
  assert.strictEqual(versionFromTag('5.0.0'), '');
});

test('isPrereleaseVersion reads the prerelease segment, not any dash', () => {
  assert.strictEqual(isPrereleaseVersion('5.0.0'), false);
  assert.strictEqual(isPrereleaseVersion('5.0.0-beta.51'), true);
  assert.strictEqual(isPrereleaseVersion('5.1.0-rc.1'), true);
  // Build metadata may contain a dash and is not a prerelease marker.
  assert.strictEqual(isPrereleaseVersion('5.0.0+sha-abc123'), false);
  assert.strictEqual(isPrereleaseVersion('not-semver'), null);
});

test('GA on main takes the Latest marker', () => {
  assert.deepStrictEqual(
    releaseFlags({ refName: 'main', tag: 'workflow@5.0.0' }),
    { latestFlag: '--latest', prerelease: false, version: '5.0.0' }
  );
});

test('a beta on main is a prerelease and does not take the Latest marker', () => {
  assert.deepStrictEqual(
    releaseFlags({ refName: 'main', tag: 'workflow@5.0.0-beta.51' }),
    { latestFlag: '--latest=false', prerelease: true, version: '5.0.0-beta.51' }
  );
});

// The regression this whole file exists for: `stable` publishes GA 4.x
// versions. Those are not prereleases, but they must never reclaim the Latest
// marker from the 5.x line.
test('GA on stable is not a prerelease but never claims Latest', () => {
  assert.deepStrictEqual(
    releaseFlags({ refName: 'stable', tag: 'workflow@4.7.0' }),
    { latestFlag: '--latest=false', prerelease: false, version: '4.7.0' }
  );
});

test('a prerelease cut off a maintenance branch stays a prerelease', () => {
  assert.deepStrictEqual(
    releaseFlags({ refName: 'stable', tag: 'workflow@4.8.0-beta.1' }),
    { latestFlag: '--latest=false', prerelease: true, version: '4.8.0-beta.1' }
  );
});

test('releaseFlags refuses a tag it cannot read a version out of', () => {
  assert.throws(
    () => releaseFlags({ refName: 'main', tag: '' }),
    /Could not read a semver version/
  );
  assert.throws(
    () => releaseFlags({ refName: 'main', tag: 'workflow@nightly' }),
    /Could not read a semver version/
  );
});

test('parseArgs requires both the tag and the ref name', () => {
  assert.deepStrictEqual(parseArgs(['workflow@5.0.0', 'main']), {
    refName: 'main',
    tag: 'workflow@5.0.0',
  });
  assert.throws(() => parseArgs(['workflow@5.0.0']), /Usage: release-flags/);
  assert.throws(() => parseArgs([]), /Usage: release-flags/);
});
