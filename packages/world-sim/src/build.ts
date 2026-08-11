/**
 * Bundle a project's workflows for the simulator.
 *
 * The workflow orchestrator runs from a *code string* inside a VM
 * (`workflowEntrypoint(workflowCode)`), so there is no way to hand the runtime
 * a live function reference — a scenario needs the same compiled combined
 * bundle a real deployment would serve. This mirrors what `@workflow/vitest`
 * does in its global setup, with one addition: the build's manifest is
 * returned, which is how a scenario can name a workflow by its plain function
 * name instead of importing a client-transformed reference.
 *
 * This module reaches SWC and esbuild through `@workflow/builders`, so it is
 * deliberately *not* part of the package's main entry — see `load.ts`. Import
 * it as `@workflow/world-sim/build`, and only from something that compiles.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BaseBuilder,
  createBaseBuilderConfig,
  type WorkflowManifest,
} from '@workflow/builders';

export interface SimBuildOptions {
  /** Project directory containing the workflows to compile. */
  cwd: string;
  /** Directories (relative to `cwd`) to scan. Defaults to the project root. */
  dirs?: string[];
  /** Where to write the generated bundles. Defaults to `<cwd>/.workflow-sim`. */
  outDir?: string;
}

export interface SimBundle {
  /** Absolute path of the combined flow+step bundle. */
  flowBundlePath: string;
  manifest: WorkflowManifest;
  /**
   * Workflow function name → machine workflow id, flattened from the manifest.
   * Ambiguous short names (same function name in two files) are omitted in
   * favour of their `<file>#<fn>` keys, which are always present.
   */
  workflowIds: Record<string, string>;
}

class SimBuilder extends BaseBuilder {
  #outDir: string;
  manifest: WorkflowManifest = {};

  constructor(workingDir: string, outDir: string, dirs: string[]) {
    super({
      ...createBaseBuilderConfig({ workingDir, dirs }),
      // 'next' emits ESM with Node-compatible output, which is what a plain
      // `import()` in this process can load.
      buildTarget: 'next',
      suppressCreateWorkflowsBundleLogs: true,
      suppressCreateWebhookBundleLogs: true,
      suppressCreateManifestLogs: true,
    });
    this.#outDir = outDir;
  }

  override async build(): Promise<void> {
    const inputFiles = await this.getInputFiles();
    await mkdir(this.#outDir, { recursive: true });
    const { manifest } = await this.createCombinedBundle({
      inputFiles,
      stepsOutfile: join(this.#outDir, '__step_registrations.mjs'),
      flowOutfile: join(this.#outDir, 'combined.mjs'),
      format: 'esm',
      bundleFinalOutput: false,
      externalizeNonSteps: true,
      // Nothing downstream bundles this output — Node imports it directly — so
      // project-local imports have to be inlined rather than left as bare `.ts`
      // specifiers.
      bundleTransitiveLocalStepDependencies: true,
    });
    this.manifest = manifest;
  }
}

export async function buildSimBundle(
  options: SimBuildOptions
): Promise<SimBundle> {
  const outDir = options.outDir ?? join(options.cwd, '.workflow-sim');
  const builder = new SimBuilder(options.cwd, outDir, options.dirs ?? ['.']);
  await builder.build();

  const workflowIds: Record<string, string> = {};
  const ambiguous = new Set<string>();
  for (const [file, fns] of Object.entries(builder.manifest.workflows ?? {})) {
    for (const [fn, { workflowId }] of Object.entries(fns)) {
      workflowIds[`${file}#${fn}`] = workflowId;
      if (fn in workflowIds) ambiguous.add(fn);
      else workflowIds[fn] = workflowId;
    }
  }
  for (const name of ambiguous) delete workflowIds[name];

  return {
    flowBundlePath: join(outDir, 'combined.mjs'),
    manifest: builder.manifest,
    workflowIds,
  };
}
