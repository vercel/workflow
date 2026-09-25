const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SCRIPT = path.join(__dirname, 'with-rate-limit-retry.sh');

// A fake CLI that fails with `failWith` on its first `failures` calls, then
// prints `ok` to stdout. It counts calls in a file so the test can read them.
function fakeCli(failures, failWith) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-limit-retry-'));
  const counter = path.join(dir, 'calls');
  const cli = path.join(dir, 'fake-vercel');
  fs.writeFileSync(
    cli,
    `#!/usr/bin/env bash
calls=$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 ))
echo "$calls" > "${counter}"
echo "progress $calls" >&2
if (( calls <= ${failures} )); then
  echo "${failWith}" >&2
  exit 1
fi
echo ok
`,
    { mode: 0o755 }
  );
  return {
    cli,
    calls: () => Number(fs.readFileSync(counter, 'utf8')),
  };
}

function run(cli, env = {}) {
  return spawnSync('bash', [SCRIPT, cli, 'deploy'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RATE_LIMIT_BASE_DELAY_SECONDS: '0',
      ...env,
    },
  });
}

const RATE_LIMITED =
  'Error: Rate limited. Too many requests to the same endpoint: /teams';

test('retries a rate-limited command until it succeeds', () => {
  const fake = fakeCli(2, RATE_LIMITED);
  const result = run(fake.cli);

  assert.equal(result.status, 0);
  assert.equal(fake.calls(), 3);
  // Only the successful attempt's stdout reaches the caller.
  assert.equal(result.stdout, 'ok\n');
  assert.match(result.stderr, /progress 1\n.*Rate limited/s);
  assert.match(result.stderr, /attempt 2 of 5/);
});

test('does not retry other failures', () => {
  const fake = fakeCli(1, 'Error: Project not found');
  const result = run(fake.cli);

  assert.equal(result.status, 1);
  assert.equal(fake.calls(), 1);
  assert.equal(result.stdout, '');
});

test('gives up after the last attempt with the command status', () => {
  const fake = fakeCli(10, RATE_LIMITED);
  const result = run(fake.cli, { RATE_LIMIT_MAX_ATTEMPTS: '3' });

  assert.equal(result.status, 1);
  assert.equal(fake.calls(), 3);
});
