const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const SCRIPT = path.join(__dirname, 'aggregate-e2e-results.js');

// vitest JSON-reporter shape for one result file: `passed` passing assertions
// plus one failed assertion per title in `failedTitles`.
function resultJson(fileLabel, passed, failedTitles = []) {
  const assertionResults = [];
  for (let i = 0; i < passed; i++) {
    assertionResults.push({
      status: 'passed',
      title: `pass ${i}`,
      fullName: `e2e pass ${i}`,
    });
  }
  for (const title of failedTitles) {
    assertionResults.push({
      status: 'failed',
      title,
      fullName: `e2e ${title}`,
      failureMessages: ['AssertionError: boom'],
    });
  }
  return JSON.stringify({
    testResults: [
      { name: `/x/${fileLabel}`, duration: 1000, assertionResults },
    ],
  });
}

// Writes fixture files (map of `e2e-<category>-<app>.json` -> JSON) into a fresh
// temp dir, runs the aggregate script against it, and returns stdout. The
// script exits non-zero when tests failed, so read stdout off the thrown error.
function renderAggregate(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-agg-'));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  try {
    return execFileSync(
      process.execPath,
      [SCRIPT, dir, '--mode', 'aggregate', '--run-url', 'https://gh/run/1'],
      { encoding: 'utf8' }
    );
  } catch (error) {
    return error.stdout;
  }
}

test('few failures list inline above a collapsed summary section', () => {
  const body = renderAggregate({
    'e2e-vercel-prod-nextjs-turbopack.json': resultJson('a', 40, [
      'sleeps forever',
      'hook race',
    ]),
    'e2e-local-dev-hono.json': resultJson('b', 30),
  });

  // Failed section is first, renamed, and appears before the summary section.
  assert.match(body, /### ❌ Failed E2E Tests/);
  assert.doesNotMatch(body, /### ❌ Failed Tests\n/);
  assert.ok(
    body.indexOf('### ❌ Failed E2E Tests') <
      body.indexOf('### E2E Test Summary'),
    'Failed E2E Tests should come before E2E Test Summary'
  );

  // Under the inline threshold → heading, not a <details>, and every test listed.
  assert.match(body, /#### ▲ Vercel Production \(2 failed\)/);
  assert.match(body, /- `sleeps forever`/);
  assert.match(body, /- `hook race`/);

  // Summary and per-category breakdown are both collapsible under the section.
  assert.match(body, /### E2E Test Summary/);
  assert.match(body, /<details>\n<summary>Summary<\/summary>/);
  assert.match(body, /<details>\n<summary>Details by Category<\/summary>/);

  // One workflow-run link, and no leftover redundant blurbs.
  assert.match(body, /📋 \[View full workflow run\]\(https:\/\/gh\/run\/1\)/);
  assert.doesNotMatch(body, /Some E2E test jobs failed/);
  assert.doesNotMatch(body, /Check the \[workflow run\]/);
});

test('a category with >= 10 failures collapses into a <details>', () => {
  const failedTitles = Array.from({ length: 12 }, (_, i) => `fail-${i}`);
  const body = renderAggregate({
    'e2e-vercel-prod-nextjs-turbopack.json': resultJson('a', 5, failedTitles),
  });

  assert.match(body, /### ❌ Failed E2E Tests/);
  // The category heading is now the <summary>, not a #### heading.
  assert.match(
    body,
    /<details>\n<summary>▲ Vercel Production \(12 failed\)<\/summary>/
  );
  assert.doesNotMatch(body, /#### ▲ Vercel Production/);
  assert.match(body, /- `fail-11`/);
});

test('all-passing runs omit the Failed E2E Tests section entirely', () => {
  const body = renderAggregate({
    'e2e-vercel-prod-vite.json': resultJson('a', 20),
  });

  assert.match(body, /✅ \*\*All tests passed\*\*/);
  assert.doesNotMatch(body, /Failed E2E Tests/);
  // The summary section is still present.
  assert.match(body, /### E2E Test Summary/);
  assert.match(body, /<details>\n<summary>Summary<\/summary>/);
});

test('Details by Category has no nested collapsibles', () => {
  const body = renderAggregate({
    'e2e-vercel-prod-nextjs-turbopack.json': resultJson('a', 40, ['x']),
    'e2e-local-dev-hono.json': resultJson('b', 30),
  });

  // Isolate the Details-by-Category block and assert it opens exactly one
  // <details> (its own) — categories inside are plain bold headings.
  const start = body.indexOf('<summary>Details by Category</summary>');
  const block = body.slice(start);
  const nestedDetails = (block.match(/<details>/g) || []).length;
  assert.strictEqual(nestedDetails, 0, 'no nested <details> inside the block');
  assert.match(block, /\*\*❌ ▲ Vercel Production\*\*/);
  assert.match(block, /\*\*✅ 💻 Local Development\*\*/);
});
