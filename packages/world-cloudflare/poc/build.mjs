// Compile the POC workflows with the Workflow SDK builder and write a
// manifest of workflow ids the Worker can start by name.
//
// The output (`poc/.workflow/combined.mjs`) is *not* bundled: it imports
// `workflow/runtime` and the step registrations, and wrangler bundles it into
// the Worker together with the Durable Object classes.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSimBundle } from '@workflow/world-sim/build';

const pocDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(pocDir, '.workflow');

const bundle = await buildSimBundle({
  cwd: pocDir,
  dirs: ['workflows'],
  outDir,
});

// Workers have no `import.meta.url` for bundled modules. The builder's ESM
// banner only uses it to seed `createRequire`, so give it a stable file URL.
for (const file of ['combined.mjs', '__step_registrations.mjs']) {
  const path = join(outDir, file);
  const source = await readFile(path, 'utf8');
  await writeFile(
    path,
    source.replaceAll(
      'import.meta.url',
      JSON.stringify('file:///worker/poc.mjs')
    )
  );
}

// A run object needs a workflow route of its own (see `createFlowRoute` in
// src/runtime.ts), so expose the route factory next to the shared route.
{
  const path = join(outDir, 'combined.mjs');
  const source = await readFile(path, 'utf8');
  const marker = 'export const POST = workflowEntrypoint(workflowCode';
  if (!source.includes(marker)) {
    throw new Error('[poc] unexpected combined bundle shape');
  }
  await writeFile(
    path,
    `${source}\nexport const createFlowRoute = () => workflowEntrypoint(workflowCode);\n`
  );
}

// The deployment id names this exact build. Runs are pinned to it: a run DO
// refuses to execute a run that was created by a different build.
const combined = await readFile(bundle.flowBundlePath);
const steps = await readFile(join(outDir, '__step_registrations.mjs'));
const deploymentId = `dpl_${createHash('sha256')
  .update(combined)
  .update(steps)
  .digest('hex')
  .slice(0, 24)}`;

await writeFile(
  join(outDir, 'build-info.mjs'),
  `export const deploymentId = ${JSON.stringify(deploymentId)};\n` +
    `export const workflowIds = ${JSON.stringify(bundle.workflowIds, null, 2)};\n`
);
await writeFile(
  join(outDir, 'build-info.d.mts'),
  'export declare const deploymentId: string;\n' +
    'export declare const workflowIds: Record<string, string>;\n'
);
await writeFile(
  join(outDir, 'combined.d.mts'),
  'type Route = (req: Request) => Promise<Response>;\n' +
    'export declare const POST: Route;\n' +
    'export declare const createFlowRoute: () => Route;\n'
);
console.log(
  `[poc] built ${Object.keys(bundle.workflowIds).length} workflow ids, ${deploymentId}`
);
