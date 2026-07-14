import { constants } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BaseBuilder,
  createBaseBuilderConfig,
  NORMALIZE_REQUEST_CODE,
  replaceGeneratedRouteExport,
  resolveProjectRoot,
  type SvelteKitConfig,
} from '@workflow/builders';

const SVELTEKIT_VIRTUAL_MODULES = [
  '$env/*', // All $env subpaths
  '$lib', // Exact $lib import
  '$lib/*', // All $lib subpaths
  '$app/*', // All $app subpaths
];

export class SvelteKitBuilder extends BaseBuilder {
  #routesDir: string | undefined;

  constructor(config: Partial<SvelteKitConfig> & { routesDir?: string } = {}) {
    const workingDir = resolve(config.workingDir || process.cwd());
    const dirs = config.dirs ?? [
      'workflows',
      'src/workflows',
      'routes',
      'src/routes',
    ];
    const projectRoot = config.projectRoot ?? resolveProjectRoot(workingDir);
    const routesDir = config.routesDir
      ? resolve(workingDir, config.routesDir)
      : undefined;
    super({
      ...createBaseBuilderConfig({
        workingDir,
        projectRoot,
        dirs,
        watch: config.watch,
        externalPackages: [...SVELTEKIT_VIRTUAL_MODULES],
      }),
      ...config,
      dirs,
      buildTarget: 'sveltekit' as const,
      workingDir,
      projectRoot,
      moduleSpecifierRoot: config.moduleSpecifierRoot ?? workingDir,
      externalPackages: [...SVELTEKIT_VIRTUAL_MODULES],
    });
    this.#routesDir = routesDir;
  }

  override async build(): Promise<void> {
    const routesDir = await this.loadRoutesDirectory();
    const workflowGeneratedDir = join(routesDir, '.well-known/workflow/v1');

    // Ensure output directories exist
    await mkdir(workflowGeneratedDir, { recursive: true });

    // Add .gitignore to exclude generated files from version control
    if (process.env.VERCEL_DEPLOYMENT_ID === undefined) {
      await writeFile(join(workflowGeneratedDir, '.gitignore'), '*');
    }

    // Get workflow and step files to bundle
    const inputFiles = await this.getInputFiles();
    const tsconfigPath = await this.findTsConfigPath();

    const options = {
      inputFiles,
      workflowGeneratedDir,
      tsconfigPath,
    };

    // Generate the three SvelteKit route handlers
    const stepsManifest = await this.buildStepsRoute(options);
    const workflowsManifest = await this.buildWorkflowsRoute(options);
    await this.buildWebhookRoute({ workflowGeneratedDir });

    // Merge manifests from both bundles
    const manifest = {
      steps: { ...stepsManifest.steps, ...workflowsManifest.steps },
      workflows: { ...stepsManifest.workflows, ...workflowsManifest.workflows },
      classes: { ...stepsManifest.classes, ...workflowsManifest.classes },
    };

    // Generate unified manifest
    const workflowBundlePath = join(workflowGeneratedDir, 'flow/+server.js');
    const manifestJson = await this.createManifest({
      workflowBundlePath,
      manifestDir: workflowGeneratedDir,
      manifest,
    });

    // Expose manifest as a static file when WORKFLOW_PUBLIC_MANIFEST=1.
    // SvelteKit serves files from static/ at the root URL.
    if (this.shouldExposePublicManifest && manifestJson) {
      const staticManifestDir = join(
        this.config.workingDir,
        'static/.well-known/workflow/v1'
      );
      await mkdir(staticManifestDir, { recursive: true });
      if (process.env.VERCEL_DEPLOYMENT_ID === undefined) {
        await writeFile(join(staticManifestDir, '.gitignore'), '*');
      }
      await copyFile(
        join(workflowGeneratedDir, 'manifest.json'),
        join(staticManifestDir, 'manifest.json')
      );
    }
  }

  private async buildStepsRoute({
    inputFiles,
    workflowGeneratedDir,
    tsconfigPath,
  }: {
    inputFiles: string[];
    workflowGeneratedDir: string;
    tsconfigPath?: string;
  }) {
    // Create steps route: .well-known/workflow/v1/step/+server.js
    const stepsRouteDir = join(workflowGeneratedDir, 'step');
    await mkdir(stepsRouteDir, { recursive: true });

    const { manifest } = await this.createStepsBundle({
      format: 'esm',
      inputFiles,
      outfile: join(stepsRouteDir, '+server.js'),
      externalizeNonSteps: true,
      tsconfigPath,
    });

    // Post-process the generated file to wrap with SvelteKit request converter
    const stepsRouteFile = join(stepsRouteDir, '+server.js');
    let stepsRouteContent = await readFile(stepsRouteFile, 'utf-8');

    // Replace the default export with SvelteKit-compatible handler
    stepsRouteContent = replaceGeneratedRouteExport(
      stepsRouteContent,
      /export\s*\{\s*stepEntrypoint\w*\s+as\s+HEAD\s*,\s*stepEntrypoint\w*\s+as\s+POST\s*\}\s*;?\s*$/m,
      `${NORMALIZE_REQUEST_CODE}
const handleStepRequest = async ({request}) => {
  const normalRequest = await normalizeRequest(request);
  return stepEntrypoint(normalRequest);
};

export const HEAD = handleStepRequest;
export const POST = handleStepRequest;`,
      'Failed to wrap generated SvelteKit step route'
    );

    await writeFile(stepsRouteFile, stepsRouteContent);
    return manifest;
  }

  private async buildWorkflowsRoute({
    inputFiles,
    workflowGeneratedDir,
    tsconfigPath,
  }: {
    inputFiles: string[];
    workflowGeneratedDir: string;
    tsconfigPath?: string;
  }) {
    // Create workflows route: .well-known/workflow/v1/flow/+server.js
    const workflowsRouteDir = join(workflowGeneratedDir, 'flow');
    await mkdir(workflowsRouteDir, { recursive: true });

    const { manifest } = await this.createWorkflowsBundle({
      format: 'esm',
      outfile: join(workflowsRouteDir, '+server.js'),
      bundleFinalOutput: false,
      inputFiles,
      tsconfigPath,
    });

    // Post-process the generated file to wrap with SvelteKit request converter
    const workflowsRouteFile = join(workflowsRouteDir, '+server.js');
    let workflowsRouteContent = await readFile(workflowsRouteFile, 'utf-8');

    // Replace the default export with SvelteKit-compatible handler
    workflowsRouteContent = replaceGeneratedRouteExport(
      workflowsRouteContent,
      /export const POST = workflowEntrypoint\(workflowCode(?<options>[^)]*)\);?$/m,
      (_match, options = '') => `${NORMALIZE_REQUEST_CODE}
export const POST = async ({request}) => {
  const normalRequest = await normalizeRequest(request);
  return workflowEntrypoint(workflowCode${options})(normalRequest);
};`,
      'Failed to wrap generated SvelteKit workflow route'
    );
    await writeFile(workflowsRouteFile, workflowsRouteContent);

    return manifest;
  }

  private async buildWebhookRoute({
    workflowGeneratedDir,
  }: {
    workflowGeneratedDir: string;
  }) {
    // Create webhook route: .well-known/workflow/v1/webhook/[token]/+server.js
    const webhookRouteFile = join(
      workflowGeneratedDir,
      'webhook/[token]/+server.js'
    );

    await this.createWebhookBundle({
      outfile: webhookRouteFile,
      bundle: false, // SvelteKit will handle bundling
    });

    // Post-process the generated file to wrap with SvelteKit request converter
    let webhookRouteContent = await readFile(webhookRouteFile, 'utf-8');

    // Update handler signature to accept token as parameter
    webhookRouteContent = webhookRouteContent.replace(
      /async function handler\(request\) \{[\s\S]*?const token = decodeURIComponent\(pathParts\[pathParts\.length - 1\]\);/,
      `async function handler(request, token) {`
    );

    // Remove the URL parsing code since we get token from params
    webhookRouteContent = webhookRouteContent.replace(
      /const url = new URL\(request\.url\);[\s\S]*?const pathParts = url\.pathname\.split\('\/'\);[\s\S]*?\n/,
      ''
    );

    // Replace all HTTP method exports with SvelteKit-compatible handlers
    webhookRouteContent = webhookRouteContent.replace(
      /export const GET = handler;\nexport const POST = handler;\nexport const PUT = handler;\nexport const PATCH = handler;\nexport const DELETE = handler;\nexport const HEAD = handler;\nexport const OPTIONS = handler;/,
      `${NORMALIZE_REQUEST_CODE}
const createSvelteKitHandler = (method) => async ({ request, params, platform }) => {
  const normalRequest = await normalizeRequest(request);
  const response = await handler(normalRequest, params.token);
  return response;
};

export const GET = createSvelteKitHandler('GET');
export const POST = createSvelteKitHandler('POST');
export const PUT = createSvelteKitHandler('PUT');
export const PATCH = createSvelteKitHandler('PATCH');
export const DELETE = createSvelteKitHandler('DELETE');
export const HEAD = createSvelteKitHandler('HEAD');
export const OPTIONS = createSvelteKitHandler('OPTIONS');`
    );

    await writeFile(webhookRouteFile, webhookRouteContent);
  }

  private async loadRoutesDirectory(): Promise<string> {
    const routesDir =
      this.#routesDir ?? (await loadSvelteKitRoutesDir(this.config.workingDir));
    await assertDirectory(routesDir);
    return routesDir;
  }
}

export async function loadSvelteKitRoutesDir(
  workingDir: string
): Promise<string> {
  const require = createRequire(join(workingDir, 'package.json'));
  const packageJsonPath = require.resolve('@sveltejs/kit/package.json');
  const loaderPath = join(dirname(packageJsonPath), 'src/core/config/index.js');

  const configModule = await import(pathToFileURL(loaderPath).href);
  // SvelteKit 2.62+ `load_config()` resolves Vite config first. Calling it
  // while `workflow/sveltekit` is imported from vite.config.ts recursively
  // reloads vite.config.ts and leaves this top-level build unresolved.
  const config =
    configModule.load_svelte_config != null
      ? await configModule.load_svelte_config(workingDir)
      : await configModule.load_config({ cwd: workingDir });
  const routesDir = config.kit?.files?.routes;
  if (routesDir == null || typeof routesDir !== 'string') {
    throw new Error(
      'Expected SvelteKit config loader to return kit.files.routes as a string.'
    );
  }
  return routesDir;
}

async function assertDirectory(path: string): Promise<void> {
  await access(path, constants.F_OK);
  const stats = await stat(path);
  if (!stats.isDirectory()) {
    throw new Error(`Path exists but is not a directory: ${path}`);
  }
}
