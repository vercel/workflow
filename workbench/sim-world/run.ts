/**
 * Play the scenario book and print each event stream.
 *
 *   pnpm sim                       # every scenario
 *   pnpm sim hook                  # scenarios whose id or name contains "hook"
 *   pnpm sim in-flight-after-decision   # one scenario, by id
 *   pnpm sim --verbose             # include queue deliveries in the trace
 *   pnpm sim --no-color            # plain ASCII, e.g. for a golden file
 *
 * Colour is on by default when stdout is a terminal and off otherwise, so
 * `pnpm sim > out.txt` already produces a diffable file; `--no-color` and
 * `NO_COLOR` force it off, `--color` forces it on through a pipe.
 *
 * Exits non-zero when any scenario fails an expectation or trips a
 * consistency check, so this doubles as a test command.
 */

import { fileURLToPath } from 'node:url';
import {
  buildSimBundle,
  loadFlowHandler,
  renderScenario,
  renderSummary,
  runScenario,
  type ScenarioResult,
} from '@workflow/world-sim';
import { scenarios } from './scenarios/index.ts';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const color = args.includes('--no-color')
  ? false
  : args.includes('--color')
    ? true
    : undefined;
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
// Scenarios run strictly one at a time: each installs a virtual clock and a
// process-global World, both of which are singletons.
for (const spec of selected) {
  const result = await runScenario(spec, {
    handler,
    workflowIds: bundle.workflowIds,
  });
  results.push(result);
  console.log(renderScenario(result, { verbose, color }));
  console.log('');
}

console.log(renderSummary(results, { color }));
process.exit(results.every((r) => r.ok) ? 0 : 1);
