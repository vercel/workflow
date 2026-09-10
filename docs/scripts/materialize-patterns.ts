/**
 * materialize-patterns — write every installable pattern's registry payload
 * directly into the install fixture (workbench/install-fixture/app/workflows)
 * so the whole surface can be typechecked and `next build`-verified without
 * network access. The shadcn-CLI e2e does the same through the real CLI.
 *
 * Run via `pnpm materialize-patterns` (from docs/).
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registryItems } from '../lib/patterns/manifest';

const WORKFLOW_PATH_PREFIX = 'workflows/';
const fixtureAppDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'workbench',
  'install-fixture',
  'app'
);

const workflowsDir = join(fixtureAppDir, 'workflows');
rmSync(workflowsDir, { recursive: true, force: true });
mkdirSync(workflowsDir, { recursive: true });
writeFileSync(join(workflowsDir, '.gitkeep'), '');

let fileCount = 0;
let patternCount = 0;

for (const item of registryItems) {
  if (item.installable === false) continue;

  const seen = new Set<string>();
  for (const snippet of item.snippets) {
    const caption = snippet.caption;
    const isWorkflow = caption?.startsWith(WORKFLOW_PATH_PREFIX);
    const isLib = caption?.startsWith('lib/');
    if (!caption || (!isWorkflow && !isLib)) continue;
    if (seen.has(caption)) continue;
    seen.add(caption);

    // Same target layout the /r route declares: workflows under app/,
    // lib files at the project root.
    const target = isWorkflow
      ? join(fixtureAppDir, caption)
      : join(fixtureAppDir, '..', caption);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, snippet.installCode ?? snippet.code);
    fileCount++;
  }
  if (seen.size > 0) patternCount++;
}

console.log(
  `Materialized ${fileCount} workflow files from ${patternCount} patterns into workbench/install-fixture.`
);
