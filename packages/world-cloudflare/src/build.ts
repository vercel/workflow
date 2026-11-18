/**
 * `@workflow/world-cloudflare/build`: compile a project's workflows into
 * modules a Worker can import.
 *
 * Runs in Node at build time (before `wrangler dev` / `wrangler deploy`), not
 * in the Worker. The output is *not* bundled: it imports `workflow/runtime`
 * and the step registrations, and wrangler bundles it into the Worker
 * together with the Durable Object classes.
 *
 * Writes, under `outDir`:
 *  - `combined.mjs`: exports `createFlowRoute`, the workflow route factory to
 *    pass to `setupCloudflareWorld()`;
 *  - `build-info.mjs`: exports `deploymentId` (names this exact build; runs
 *    are pinned to it) and `workflowIds` (function name to workflow id, for
 *    `start({ workflowId })`);
 *  - `.d.mts` declarations for both.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSimBundle } from '@workflow/world-sim/build';

export interface CloudflareBuildOptions {
  /** Project directory containing the workflows. */
  cwd: string;
  /** Directories (relative to `cwd`) to scan. Defaults to the project root. */
  dirs?: string[];
  /** Where to write the generated modules. Defaults to `<cwd>/.workflow`. */
  outDir?: string;
}

export interface CloudflareBuildResult {
  outDir: string;
  /** Names this exact build. A run only executes on the build that created it. */
  deploymentId: string;
  /** Workflow function name to workflow id. */
  workflowIds: Record<string, string>;
}

const ROUTE_MARKER = 'export const POST = workflowEntrypoint(workflowCode';

export async function buildCloudflareWorkflows(
  options: CloudflareBuildOptions
): Promise<CloudflareBuildResult> {
  const outDir = options.outDir ?? join(options.cwd, '.workflow');
  const bundle = await buildSimBundle({
    cwd: options.cwd,
    dirs: options.dirs,
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
        JSON.stringify('file:///worker/workflows.mjs')
      )
    );
  }

  // A run object needs a workflow route of its own (see `createFlowRoute` in
  // runtime.ts), so expose the route factory next to the shared route.
  {
    const path = join(outDir, 'combined.mjs');
    const source = await readFile(path, 'utf8');
    if (!source.includes(ROUTE_MARKER)) {
      throw new Error(
        '@workflow/world-cloudflare: the combined workflow bundle has an unexpected shape'
      );
    }
    await writeFile(
      path,
      `${source}\nexport const createFlowRoute = () => workflowEntrypoint(workflowCode);\n`
    );
  }

  // The deployment id names this exact build. Runs are pinned to it: a run
  // object refuses to execute a run that was created by a different build.
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

  return { outDir, deploymentId, workflowIds: bundle.workflowIds };
}
