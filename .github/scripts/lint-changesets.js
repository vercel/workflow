#!/usr/bin/env node
/**
 * Lints the changesets a pull request adds or edits.
 *
 * A changeset summary is copied verbatim into the package's CHANGELOG.md and
 * the GitHub release notes, where users read it next to every other entry of
 * the release. Reviewers kept trimming the same things out of them: rationale
 * paragraphs, implementation detail, bullet lists, and several changesets for
 * what is one change (see #4070/#4143, #4048, #3988, #4168, #4760). This
 * script turns those review comments into a check, so the feedback arrives
 * before a reviewer has to give it.
 *
 * Errors fail the job:
 *
 *   - count:     the PR adds more than one changeset. One change, one
 *                changelog entry; a single changeset may list every package
 *                the PR touches. Add the `allow-multiple-changesets` label
 *                when separate entries really are clearer (rare).
 *   - length:    the summary is longer than MAX_CHARS characters. Link URLs
 *                are not counted, so pointing at the docs for detail is free.
 *   - structure: the summary has more than one paragraph, a heading, a list,
 *                or a code block. The changelog renders each changeset as a
 *                single bullet.
 *   - empty:     packages are listed but the summary is empty, which renders
 *                as a bare bullet.
 *
 * An empty changeset (`pnpm changeset --empty`, which lists no packages)
 * releases nothing and its summary is never published, so it is not linted.
 *
 * Warnings are annotated on the file but do not fail the job:
 *
 *   - length:    the summary is longer than RECOMMENDED_CHARS characters.
 *   - sentences: the summary is more than MAX_SENTENCES sentences.
 *   - wrapped:   the summary is hard-wrapped over several lines.
 *   - prefix:    the summary starts with a package or commit-type prefix such
 *                as `[core]` or `fix(core):`; the changelog already groups
 *                entries by package.
 *
 * Only changesets added or modified relative to the base are linted, so a
 * pending changeset that predates these rules never fails an unrelated PR.
 *
 * Usage:
 *   node .github/scripts/lint-changesets.js [--base <ref>] [--all]
 *
 *   --base <ref>  Lint changesets changed between `git merge-base <ref> HEAD`
 *                 and the working tree. Defaults to `origin/main`.
 *   --all         Lint every pending changeset instead (skips the count rule).
 *
 * In CI, PR_LABELS (a JSON array of label names) carries the override label.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX_CHARS = 600;
const RECOMMENDED_CHARS = 300;
const MAX_SENTENCES = 2;
const MAX_CHANGESETS = 1;
const OVERRIDE_LABEL = 'allow-multiple-changesets';

const CHANGESET_DIR = '.changeset';

/** Top-level `.changeset/*.md` only: `pre/` holds already-released entries. */
function isChangesetPath(file) {
  const normalized = file.split(path.sep).join('/');
  return (
    path.posix.dirname(normalized) === CHANGESET_DIR &&
    normalized.endsWith('.md') &&
    path.posix.basename(normalized).toLowerCase() !== 'readme.md'
  );
}

/**
 * Splits a changeset into its release list and summary. Returns null when the
 * file has no frontmatter, which `changeset version` would reject anyway.
 */
function parseChangeset(content) {
  const text = content.replace(/\r\n/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)^---[ \t]*(?:\n|$)([\s\S]*)$/m.exec(
    text
  );
  if (!match || match.index !== 0) {
    return null;
  }

  const [, frontmatter, rest] = match;
  const releases = [];
  for (const line of frontmatter.split('\n')) {
    const release = /^\s*(["']?)(.+?)\1\s*:\s*([a-z]+)\s*$/.exec(line);
    if (release) {
      releases.push({ name: release[2], type: release[3] });
    }
  }

  // Line (1-based) in the file where the summary text begins, for annotations.
  const summaryStart =
    match[0].length - rest.length + (rest.length - rest.trimStart().length);
  const summaryLine = text.slice(0, summaryStart).split('\n').length;

  return { releases, summary: rest.trim(), summaryLine };
}

/** The summary as a reader sees it: link URLs are not shown, so drop them. */
function visibleText(summary) {
  return summary.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
}

function countSentences(summary) {
  const text = visibleText(summary)
    .replace(/`[^`]*`/g, 'code')
    .replace(/\b(?:e\.g|i\.e|etc|vs|cf|approx)\./gi, 'abbr')
    .trim();
  if (!text) {
    return 0;
  }
  // A terminator followed by whitespace and the start of a new sentence, or
  // by the end of the text. Version numbers and paths never match.
  const terminators =
    text.match(/[.!?](?=\s+[A-Z0-9`*_"'([]|\s*$)/g)?.length ?? 0;
  return /[.!?]$/.test(text) ? terminators : terminators + 1;
}

/** Returns `{ rule, severity, message }[]` for one parsed changeset. */
function lintChangeset(parsed) {
  if (!parsed) {
    return [
      {
        rule: 'structure',
        severity: 'error',
        message:
          'Missing frontmatter. A changeset starts with a `---` block listing packages, then the summary.',
      },
    ];
  }

  const { releases, summary } = parsed;
  const problems = [];

  // An empty changeset releases nothing, so its summary is never published.
  if (releases.length === 0) {
    return problems;
  }
  if (!summary) {
    problems.push({
      rule: 'empty',
      severity: 'error',
      message:
        'Packages are listed but the summary is empty, so the changelog would get a blank entry. Describe the change in a sentence.',
    });
    return problems;
  }

  const lines = summary.split('\n');
  if (/\n[ \t]*\n/.test(summary)) {
    problems.push({
      rule: 'structure',
      severity: 'error',
      message:
        'The summary has more than one paragraph. The changelog renders a changeset as one bullet: keep the line that says what changed for users, and leave the rationale to the PR description and docs.',
    });
  }
  if (lines.some((line) => /^\s{0,3}#{1,6}\s/.test(line))) {
    problems.push({
      rule: 'structure',
      severity: 'error',
      message: 'Headings are not allowed in a changeset summary.',
    });
  }
  if (lines.some((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line))) {
    problems.push({
      rule: 'structure',
      severity: 'error',
      message:
        'Lists are not allowed in a changeset summary. Fold the items into one sentence, or split unrelated changes into separate PRs.',
    });
  }
  if (/^\s*(?:```|~~~)/m.test(summary)) {
    problems.push({
      rule: 'structure',
      severity: 'error',
      message:
        'Code blocks are not allowed in a changeset summary. Use inline code, and link to the docs for examples.',
    });
  }

  const length = visibleText(summary).length;
  if (length > MAX_CHARS) {
    problems.push({
      rule: 'length',
      severity: 'error',
      message: `The summary is ${length} characters; the limit is ${MAX_CHARS} (aim for under ${RECOMMENDED_CHARS}). Say what changed for users, and link to the docs for details.`,
    });
  } else if (length > RECOMMENDED_CHARS) {
    problems.push({
      rule: 'length',
      severity: 'warning',
      message: `The summary is ${length} characters; aim for under ${RECOMMENDED_CHARS}. Say what changed for users, and link to the docs for details.`,
    });
  }

  const sentences = countSentences(summary);
  if (sentences > MAX_SENTENCES) {
    problems.push({
      rule: 'sentences',
      severity: 'warning',
      message: `The summary looks like ${sentences} sentences; keep it to one, or ${MAX_SENTENCES} at most.`,
    });
  }

  if (lines.length > 1 && !problems.some((p) => p.rule === 'structure')) {
    problems.push({
      rule: 'wrapped',
      severity: 'warning',
      message:
        'The summary is hard-wrapped over several lines. Write it as a single line.',
    });
  }

  if (
    /^\[[^\]]+\]\s/.test(summary) ||
    /^(?:feat|fix|chore|refactor|perf|docs|test|ci|build)(?:\([^)]*\))?!?:/i.test(
      summary
    )
  ) {
    problems.push({
      rule: 'prefix',
      severity: 'warning',
      message:
        'Drop the package or commit-type prefix: the changelog already groups entries by package. Start with a verb, e.g. "Fix …" or "Add …".',
    });
  }

  return problems;
}

/** Errors for the PR as a whole, given the changesets it adds. */
function lintCount(addedFiles, labels = []) {
  if (addedFiles.length <= MAX_CHANGESETS) {
    return [];
  }
  const list = addedFiles.map((file) => `\`${file}\``).join(', ');
  if (labels.includes(OVERRIDE_LABEL)) {
    return [
      {
        rule: 'count',
        severity: 'warning',
        message: `This PR adds ${addedFiles.length} changesets (${list}); accepted because of the \`${OVERRIDE_LABEL}\` label.`,
      },
    ];
  }
  return [
    {
      rule: 'count',
      severity: 'error',
      message: `This PR adds ${addedFiles.length} changesets (${list}). Most PRs need exactly one: a single changeset can list every package the PR changes, at the highest bump each needs, and gives the release one entry. If separate entries really are clearer, add the \`${OVERRIDE_LABEL}\` label.`,
    },
  ];
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Changesets added or modified since the merge base with `base`, including
 * uncommitted and untracked files so the script is useful before committing.
 */
function changedChangesets(base, cwd) {
  const mergeBase = git(['merge-base', base, 'HEAD'], cwd);
  const output = [
    git(
      [
        'diff',
        '--name-status',
        '--no-renames',
        '--diff-filter=AM',
        mergeBase,
        '--',
        CHANGESET_DIR,
      ],
      cwd
    ),
    git(
      ['ls-files', '--others', '--exclude-standard', '--', CHANGESET_DIR],
      cwd
    )
      .split('\n')
      .filter(Boolean)
      .map((file) => `A\t${file}`)
      .join('\n'),
  ].join('\n');

  const added = new Set();
  const modified = new Set();
  for (const line of output.split('\n')) {
    const [status, file] = line.split('\t');
    if (!file || !isChangesetPath(file)) continue;
    (status === 'A' ? added : modified).add(file);
  }
  return { added: [...added].sort(), modified: [...modified].sort() };
}

function pendingChangesets(cwd) {
  return fs
    .readdirSync(path.join(cwd, CHANGESET_DIR))
    .map((name) => `${CHANGESET_DIR}/${name}`)
    .filter(isChangesetPath)
    .sort();
}

function parseArgs(argv) {
  const options = { base: 'origin/main', all: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') {
      options.all = true;
    } else if (arg === '--base' && argv[i + 1]) {
      options.base = argv[++i];
    } else if (arg.startsWith('--base=')) {
      options.base = arg.slice('--base='.length);
    } else {
      throw new Error(
        `Unknown argument: ${arg}\nUsage: lint-changesets.js [--base <ref>] [--all]`
      );
    }
  }
  return options;
}

function parseLabels(value) {
  if (!value) return [];
  try {
    const labels = JSON.parse(value);
    return Array.isArray(labels) ? labels.map(String) : [];
  } catch {
    return [];
  }
}

function escapeAnnotation(value) {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function report(results) {
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  for (const { file, line, rule, severity, message } of results) {
    if (inActions) {
      // Annotations are shown in the log too, and on the PR's changed files.
      const props = [
        file && `file=${file}`,
        file && line && `line=${line}`,
        `title=Changeset ${rule}`,
      ]
        .filter(Boolean)
        .join(',');
      console.log(`::${severity} ${props}::${escapeAnnotation(message)}`);
      continue;
    }
    const where = file ? `${file}${line ? `:${line}` : ''}` : 'changesets';
    const icon = severity === 'error' ? '✗' : '!';
    (severity === 'error' ? console.error : console.warn)(
      `${icon} ${where} [${rule}] ${message}`
    );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const cwd = git(['rev-parse', '--show-toplevel'], process.cwd());

  let files;
  const results = [];
  if (options.all) {
    files = pendingChangesets(cwd);
  } else {
    const { added, modified } = changedChangesets(options.base, cwd);
    files = [...added, ...modified].sort();
    results.push(...lintCount(added, parseLabels(process.env.PR_LABELS)));
  }

  for (const file of files) {
    const parsed = parseChangeset(
      fs.readFileSync(path.join(cwd, file), 'utf8')
    );
    for (const problem of lintChangeset(parsed)) {
      results.push({
        file,
        line: parsed ? parsed.summaryLine : 1,
        ...problem,
      });
    }
  }

  report(results);
  const errors = results.filter((r) => r.severity === 'error').length;
  const warnings = results.length - errors;
  const scope = options.all ? 'pending' : `changed since ${options.base}`;
  const summary = `${files.length} changeset(s) ${scope}: ${errors} error(s), ${warnings} warning(s).`;
  if (errors > 0) {
    console.error(
      `\n✗ ${summary} See "Writing changesets" in AGENTS.md for the style guide.`
    );
    process.exit(1);
  }
  console.log(`✓ ${summary}`);
}

module.exports = {
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
};

if (require.main === module) {
  main();
}
