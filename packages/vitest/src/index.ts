import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseBuilder, createBaseBuilderConfig } from '@workflow/builders';
import { setWorld } from '@workflow/core/runtime';
import { workflowTransformPlugin } from '@workflow/rollup';
import { createLocalWorld, type LocalWorld } from '@workflow/world-local';
import type { Plugin } from 'vite';

class VitestBuilder extends BaseBuilder {
  #outDir: string;

  constructor(workingDir: string, outDir: string) {
    super({
      ...createBaseBuilderConfig({
        workingDir,
        dirs: ['.'],
      }),
      buildTarget: 'next',
      suppressCreateWorkflowsBundleLogs: true,
      suppressCreateWebhookBundleLogs: true,
      suppressCreateManifestLogs: true,
    });
    this.#outDir = outDir;
  }

  protected override get shouldLogBaseBuilderInfo(): boolean {
    return false;
  }

  override async build(): Promise<void> {
    const inputFiles = await this.getInputFiles();
    await mkdir(this.#outDir, { recursive: true });

    await this.createWorkflowsBundle({
      outfile: join(this.#outDir, 'workflows.mjs'),
      bundleFinalOutput: false,
      format: 'esm',
      inputFiles,
    });

    await this.createStepsBundle({
      outfile: join(this.#outDir, 'steps.mjs'),
      externalizeNonSteps: true,
      format: 'esm',
      inputFiles,
    });
  }
}

export interface WorkflowTestOptions {
  /**
   * The working directory of the project (where workflows/ lives).
   * Defaults to process.cwd().
   */
  cwd?: string;
}

function getOutDir(cwd: string): string {
  return join(cwd, '.workflow-vitest');
}

/**
 * Vitest plugin for workflow testing. Handles SWC transforms, bundle building,
 * and in-process handler registration automatically.
 *
 * @example
 * ```ts
 * // vitest.config.ts
 * import { workflow } from 'workflow/vitest';
 * import { defineConfig } from 'vitest/config';
 *
 * export default defineConfig({
 *   plugins: [workflow()],
 * });
 * ```
 */
export function workflow(): Plugin[] {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  return [
    workflowTransformPlugin(),
    {
      name: 'workflow:vitest',
      config() {
        return {
          test: {
            globalSetup: [join(dir, 'global-setup.js')],
            setupFiles: [join(dir, 'setup-file.js')],
          },
        } as Record<string, unknown>;
      },
    },
  ];
}

/**
 * Build workflow bundles for testing. Run this in vitest globalSetup.
 * This builds the workflow and step bundles to disk so they can be
 * imported by the test workers.
 */
export async function buildWorkflowTests(
  options?: WorkflowTestOptions
): Promise<void> {
  const cwd = options?.cwd ?? process.cwd();
  const outDir = getOutDir(cwd);
  const builder = new VitestBuilder(cwd, outDir);
  await builder.build();
}

let world: LocalWorld | undefined;

/**
 * Set up in-process handler routing for workflow tests.
 * Run this in vitest setupFiles (which executes in each test worker process).
 *
 * Imports the pre-built bundles, creates a local world with direct handlers,
 * and sets it as the global world.
 */
export async function setupWorkflowTests(
  options?: WorkflowTestOptions
): Promise<void> {
  const cwd = options?.cwd ?? process.cwd();
  const outDir = getOutDir(cwd);

  const workflowsModule = await import(
    /* @vite-ignore */ join(outDir, 'workflows.mjs')
  );
  const stepsModule = await import(
    /* @vite-ignore */ join(outDir, 'steps.mjs')
  );

  const workflowHandler = workflowsModule.POST as (
    req: Request
  ) => Promise<Response>;
  const stepHandler = stepsModule.POST as (req: Request) => Promise<Response>;

  world = createLocalWorld({ dataDir: join(outDir, 'data') });
  await world.start?.();

  world.registerHandler('__wkf_workflow_', workflowHandler);
  world.registerHandler('__wkf_step_', stepHandler);

  setWorld(world);
}

/**
 * Tear down the workflow test world. Call this in afterAll or vitest teardown.
 */
export async function teardownWorkflowTests(): Promise<void> {
  setWorld(undefined);
  await world?.close?.();
  world = undefined;
}
