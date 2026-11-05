const assert = require('node:assert');
const { test } = require('node:test');

const {
  MAX_CHARS,
  OVERRIDE_LABEL,
  RECOMMENDED_CHARS,
  countSentences,
  isChangesetPath,
  lintChangeset,
  lintCount,
  parseArgs,
  parseChangeset,
  parseLabels,
} = require('./lint-changesets.js');

const changeset = (summary, releases = `"@workflow/core": patch\n`) =>
  `---\n${releases}---\n\n${summary}\n`;

const rules = (content) =>
  lintChangeset(parseChangeset(content)).map(
    ({ rule, severity }) => `${severity}:${rule}`
  );

test('isChangesetPath only matches top-level changeset markdown files', () => {
  assert.strictEqual(isChangesetPath('.changeset/brave-cats-run.md'), true);
  assert.strictEqual(isChangesetPath('.changeset/README.md'), false);
  assert.strictEqual(isChangesetPath('.changeset/pre/old-entry.md'), false);
  assert.strictEqual(isChangesetPath('.changeset/config.json'), false);
  assert.strictEqual(isChangesetPath('docs/.changeset/x.md'), false);
});

test('parseChangeset reads releases, summary and the summary line', () => {
  const parsed = parseChangeset(
    `---\n"@workflow/core": minor\n'workflow': minor\n@workflow/world: patch\n---\n\nAdd a thing.\n`
  );
  assert.deepStrictEqual(parsed.releases, [
    { name: '@workflow/core', type: 'minor' },
    { name: 'workflow', type: 'minor' },
    { name: '@workflow/world', type: 'patch' },
  ]);
  assert.strictEqual(parsed.summary, 'Add a thing.');
  assert.strictEqual(parsed.summaryLine, 7);
});

test('parseChangeset handles empty changesets and CRLF line endings', () => {
  assert.deepStrictEqual(parseChangeset('---\n---\n'), {
    releases: [],
    summary: '',
    summaryLine: 3,
  });
  assert.deepStrictEqual(parseChangeset('---\n\n---\n').releases, []);
  const crlf = parseChangeset(
    '---\r\n"workflow": patch\r\n---\r\n\r\nFix it.\r\n'
  );
  assert.strictEqual(crlf.summary, 'Fix it.');
  assert.strictEqual(crlf.releases.length, 1);
});

test('parseChangeset returns null without frontmatter', () => {
  assert.strictEqual(parseChangeset('Fix it.\n'), null);
  assert.deepStrictEqual(rules('Fix it.\n'), ['error:structure']);
});

test('a terse one-line summary passes', () => {
  assert.deepStrictEqual(
    rules(
      changeset(
        'Reconnect the stream `LISTEN` connection after the database drops it, instead of crashing the process.'
      )
    ),
    []
  );
});

test('empty changesets are not linted, but listed packages need a summary', () => {
  assert.deepStrictEqual(rules('---\n---\n'), []);
  assert.deepStrictEqual(
    rules('---\n---\n\nDocs: a long note.\n\nWith two paragraphs.\n'),
    []
  );
  assert.deepStrictEqual(rules(changeset('')), ['error:empty']);
});

test('summaries over the hard limit fail, over the recommendation warn', () => {
  const sentence = (n) => `Fix ${'x'.repeat(n - 5)}.`;
  assert.deepStrictEqual(rules(changeset(sentence(RECOMMENDED_CHARS))), []);
  assert.deepStrictEqual(rules(changeset(sentence(RECOMMENDED_CHARS + 1))), [
    'warning:length',
  ]);
  assert.deepStrictEqual(rules(changeset(sentence(MAX_CHARS + 1))), [
    'error:length',
  ]);
});

test('link URLs do not count towards the length', () => {
  const url = `https://workflow-sdk.dev/${'a'.repeat(400)}`;
  assert.deepStrictEqual(
    rules(changeset(`Add \`createHook({ force })\`. See [the docs](${url}).`)),
    []
  );
});

test('multiple paragraphs, headings, lists and code blocks fail', () => {
  assert.deepStrictEqual(rules(changeset('Fix it.\n\nBecause reasons.')), [
    'error:structure',
  ]);
  assert.deepStrictEqual(rules(changeset('## Fix\nFix it.')), [
    'error:structure',
  ]);
  assert.deepStrictEqual(rules(changeset('Fix things:\n- one\n- two')), [
    'error:structure',
  ]);
  assert.deepStrictEqual(rules(changeset('Fix things:\n1. one')), [
    'error:structure',
  ]);
  assert.deepStrictEqual(rules(changeset('Fix it.\n```ts\nfoo()\n```')), [
    'error:structure',
  ]);
});

test('hard-wrapped summaries warn', () => {
  assert.deepStrictEqual(rules(changeset('Fix the thing\nthat was broken.')), [
    'warning:wrapped',
  ]);
});

test('package and commit-type prefixes warn', () => {
  assert.deepStrictEqual(rules(changeset('[core] Fix it.')), [
    'warning:prefix',
  ]);
  assert.deepStrictEqual(rules(changeset('fix(core): fix it.')), [
    'warning:prefix',
  ]);
  assert.deepStrictEqual(rules(changeset('feat!: add it.')), [
    'warning:prefix',
  ]);
  assert.deepStrictEqual(rules(changeset('`[]` arrays now serialize.')), []);
});

test('countSentences ignores abbreviations, versions and inline code', () => {
  assert.strictEqual(countSentences('Fix it'), 1);
  assert.strictEqual(countSentences('Fix it.'), 1);
  assert.strictEqual(
    countSentences('Upgrade `@vercel/queue` to 0.8.0 so sends retry.'),
    1
  );
  assert.strictEqual(
    countSentences('Shim `__dirname` so CJS deps (e.g. `google-gax`) load.'),
    1
  );
  assert.strictEqual(countSentences('Call `a.b()`. Then `c.d()`.'), 2);
  assert.strictEqual(countSentences('One. Two. Three'), 3);
  assert.deepStrictEqual(rules(changeset('One. Two. Three.')), [
    'warning:sentences',
  ]);
});

test('lintCount allows one changeset and fails on more without the label', () => {
  assert.deepStrictEqual(lintCount([]), []);
  assert.deepStrictEqual(lintCount(['.changeset/a.md']), []);

  const [error] = lintCount(['.changeset/a.md', '.changeset/b.md']);
  assert.strictEqual(error.severity, 'error');
  assert.match(error.message, /adds 2 changesets/);
  assert.match(error.message, new RegExp(OVERRIDE_LABEL));

  const [warning] = lintCount(
    ['.changeset/a.md', '.changeset/b.md'],
    ['bug', OVERRIDE_LABEL]
  );
  assert.strictEqual(warning.severity, 'warning');
});

test('parseLabels reads the JSON label list and tolerates junk', () => {
  assert.deepStrictEqual(parseLabels('["a","b"]'), ['a', 'b']);
  assert.deepStrictEqual(parseLabels(''), []);
  assert.deepStrictEqual(parseLabels(undefined), []);
  assert.deepStrictEqual(parseLabels('null'), []);
  assert.deepStrictEqual(parseLabels('not json'), []);
});

test('parseArgs reads --base and --all', () => {
  assert.deepStrictEqual(parseArgs([]), { base: 'origin/main', all: false });
  assert.deepStrictEqual(parseArgs(['--base', 'abc123']), {
    base: 'abc123',
    all: false,
  });
  assert.deepStrictEqual(parseArgs(['--base=HEAD^1', '--all']), {
    base: 'HEAD^1',
    all: true,
  });
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
});
