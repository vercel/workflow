/**
 * Play the scenario book and print each event stream.
 *
 *   pnpm sim                    # every scenario
 *   pnpm sim hook               # scenarios whose name contains "hook"
 *   pnpm sim --verbose          # include queue deliveries in the trace
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
const filters = args.filter((a) => !a.startsWith('--'));

const cwd = fileURLToPath(new URL('.', import.meta.url));

const selected = scenarios.filter(
  (s) => filters.length === 0 || filters.some((f) => s.name.includes(f))
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
  console.log(renderScenario(result, { verbose }));
  console.log('');
}

console.log(renderSummary(results));
process.exit(results.every((r) => r.ok) ? 0 : 1);
