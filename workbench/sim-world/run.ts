/**
 * Play the scenario book and print each event stream.
 *
 *   pnpm sim                       # every scenario
 *   pnpm sim hook                  # scenarios whose id or name contains "hook"
 *   pnpm sim in-flight-after-decision   # one scenario, by id
 *   pnpm sim --verbose             # include queue deliveries in the trace
 *   pnpm sim --no-color            # plain ASCII, e.g. for a golden file
 *   pnpm sim --append-only         # play against an append-only log
 *   pnpm sim --no-fence            # play with the optimistic-concurrency fence off
 *   pnpm sim --report-only         # print failures but exit 0
 *   pnpm sim --summary-file s.md   # markdown counts + table, for a PR comment
 *   pnpm sim --detail-file d.txt   # the full trace, colour-free, as an artifact
 *   pnpm sim --title 'Append-only' # heading for the summary file
 *
 * `--append-only` moves every event's position from its handler's mint to its
 * commit, which is the one change that makes a stale read impossible: the log
 * can be behind, never wrong. Six scenarios in the book fail today because it
 * is *not* how production works, so running with and without it — and diffing
 * — is how you tell which of those failures the change would actually close.
 * `--no-append-only` forces the production behaviour back on for a scenario
 * that asked for the flag itself.
 *
 * `--no-fence` turns off the optimistic-concurrency fence (both halves — the
 * count guard is evaluated inside the same predicate) for every scenario that
 * asked for it. The fence rejects a write whose snapshot predates an
 * out-of-band event: a write that an extended prefix invalidated. So a book
 * that scores the same with the fence off is a book in which no emitter is
 * prefix-sensitive, and the fence is protecting against nothing. Anything that
 * goes red only under `--no-fence` names the exception. `--fence` forces it on.
 *
 * `--no-fence` is a diagnostic, not a world: read the *violation* count, not
 * the pass count. A scenario whose whole point is that the guard fired asserts
 * exactly that with `sim.check`, so turning the guard off fails it by design —
 * `in-flight-before-decision-counted` is the one that does this today. The
 * violation count is the number that means something.
 *
 * Colour is on by default when stdout is a terminal and off otherwise, so
 * `pnpm sim > out.txt` already produces a diffable file; `--no-color` and
 * `NO_COLOR` force it off, `--color` forces it on through a pipe.
 *
 * Exits non-zero when any scenario fails an expectation or trips a
 * consistency check, so this doubles as a test command. `--report-only` keeps
 * every one of those messages and exits 0 anyway, which is what a CI job that
 * wants to *publish* the book's current state rather than gate on it needs.
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadFlowHandler,
  renderMarkdownSummary,
  renderScenario,
  renderSummary,
  runScenario,
  type ScenarioResult,
} from '@workflow/world-sim';
import { buildSimBundle } from '@workflow/world-sim/build';
import { scenarios } from './scenarios/index.ts';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const color = args.includes('--no-color')
  ? false
  : args.includes('--color')
    ? true
    : undefined;
// `undefined` leaves it to each spec, which is not the same as `false` —
// see `RunScenarioOptions.appendOnlyLog`.
const appendOnlyLog = args.includes('--no-append-only')
  ? false
  : args.includes('--append-only')
    ? true
    : undefined;
// Same tri-state as above, and for the same reason: a scenario that turns the
// fence on itself is the normal case, so `undefined` has to mean "leave it to
// the spec" rather than "off".
const preconditionGuard = args.includes('--no-fence')
  ? false
  : args.includes('--fence')
    ? true
    : undefined;
const reportOnly = args.includes('--report-only');
const summaryFile = pathValue('--summary-file');
const detailFile = pathValue('--detail-file');
// Names the summary's heading. A CI job plays the book once per world and
// concatenates the two files into one comment, where two headings reading
// `world-sim scenario book` would leave the chips line as the only way to tell
// which half you are looking at.
const summaryTitle = flagValue('--title') ?? 'world-sim scenario book';

/**
 * Read `--flag value`. Anything a flag consumes is removed from `args` before
 * the filters are taken, so `--summary-file s.md` does not also select every
 * scenario whose id contains "s.md" (which is none, but the next path won't be
 * so lucky).
 */
function flagValue(name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} needs a value`);
    process.exit(1);
  }
  args.splice(at, 2);
  return value;
}

/** `flagValue`, resolved against the cwd — for the flags that name a file. */
function pathValue(name: string): string | undefined {
  const value = flagValue(name);
  return value === undefined ? undefined : resolve(value);
}

const filters = args.filter((a) => !a.startsWith('--'));

const cwd = fileURLToPath(new URL('.', import.meta.url));

// Matched against the id first, because that is the handle a bug report or a
// commit message will have used; the prose name stays searchable as a
// fallback so `pnpm sim deadline` keeps working.
const selected = scenarios.filter(
  (s) =>
    filters.length === 0 ||
    filters.some((f) => s.id.includes(f) || s.name.includes(f))
);

if (selected.length === 0) {
  console.error(`No scenario matches ${filters.join(', ')}`);
  process.exit(1);
}

console.log('Building workflow bundle...');
const bundle = await buildSimBundle({ cwd, dirs: ['workflows'] });
const handler = await loadFlowHandler(bundle.flowBundlePath);
console.log(
  `Loaded ${Object.keys(bundle.manifest.workflows ?? {}).length} workflow module(s)\n`
);

const results: ScenarioResult[] = [];
// The detail artifact is built from the same renders as the console, only with
// colour forced off, so the file and the terminal can never disagree about
// what happened — they are the same call with one option flipped.
const detail: string[] = [];

// Scenarios run strictly one at a time: each installs a virtual clock and a
// process-global World, both of which are singletons.
for (const spec of selected) {
  const result = await runScenario(spec, {
    handler,
    workflowIds: bundle.workflowIds,
    appendOnlyLog,
    preconditionGuard,
  });
  results.push(result);
  console.log(renderScenario(result, { verbose, color }));
  console.log('');
  if (detailFile) {
    // Always verbose in the artifact: it is read when the summary was not
    // enough, and a truncated artifact just sends the reader back to a laptop.
    detail.push(renderScenario(result, { verbose: true, color: false }), '');
  }
}

console.log(renderSummary(results, { color }));

if (detailFile) {
  detail.push(renderSummary(results, { color: false }), '');
  await writeFile(detailFile, detail.join('\n'), 'utf8');
  console.log(`Wrote detail to ${detailFile}`);
}

if (summaryFile) {
  await writeFile(
    summaryFile,
    renderMarkdownSummary(results, {
      title: summaryTitle,
      // Say which world, always — including when it is the default one. A
      // summary file outlives the command line that produced it, and two of
      // these sitting side by side in a PR comment are only comparable if each
      // one states its own conditions.
      chips: [
        `log=${appendOnlyLog === true ? 'append-only' : 'mint-ordered'}`,
        `fence=${
          preconditionGuard === undefined
            ? 'per-spec'
            : preconditionGuard
              ? 'forced-on'
              : 'off'
        }`,
      ],
      detailPath: detailFile,
    }),
    'utf8'
  );
  console.log(`Wrote summary to ${summaryFile}`);
}

const failed = !results.every((r) => r.ok);
if (failed && reportOnly) {
  console.log('\n--report-only: exiting 0 despite the failures above.');
}
process.exit(failed && !reportOnly ? 1 : 0);
