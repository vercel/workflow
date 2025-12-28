import { constants } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  BaseBuilder,
  type SvelteKitConfig,
  NORMALIZE_REQUEST_CODE,
} from '@workflow/builders';

const SVELTEKIT_VIRTUAL_MODULES = [
  '$env/*', // All $env subpaths
  '$lib', // Exact $lib import
  '$lib/*', // All $lib subpaths
  '$app/*', // All $app subpaths
];

export class SvelteKitBuilder extends BaseBuilder {
  constructor(config?: Partial<SvelteKitConfig>) {
    const workingDir = config?.workingDir || process.cwd();

    super({
      ...config,
      dirs: ['workflows', 'src/workflows', 'routes', 'src/routes'],
      buildTarget: 'sveltekit' as const,
      stepsBundlePath: '', // unused in base
      workflowsBundlePath: '', // unused in base
      webhookBundlePath: '', // unused in base
      workingDir,
      externalPackages: [...SVELTEKIT_VIRTUAL_MODULES],
    });
  }

  override async build(): Promise<void> {
    // Find SvelteKit routes directory (src/routes or routes)
    const routesDir = await this.findRoutesDirectory();
    const workflowGeneratedDir = join(routesDir, '.well-known/workflow/v1');

    // Ensure output directories exist
    await mkdir(workflowGeneratedDir, { recursive: true });

    // Add .gitignore to exclude generated files from version control
    if (process.env.VERCEL_DEPLOYMENT_ID === undefined) {
      await writeFile(join(workflowGeneratedDir, '.gitignore'), '*');
    }

    // Get workflow and step files to bundle
    const inputFiles = await this.getInputFiles();
    const tsConfig = await this.getTsConfigOptions();

    const options = {
      inputFiles,
      workflowGeneratedDir,
      tsBaseUrl: tsConfig.baseUrl,
      tsPaths: tsConfig.paths,
    };

    // Generate the three SvelteKit route handlers
    const manifest = await this.buildStepsRoute(options);
    await this.buildWorkflowsRoute(options);
    await this.buildWebhookRoute({ workflowGeneratedDir });

    // Generate unified manifest
    const workflowBundlePath = join(workflowGeneratedDir, 'flow/+server.js');
    await this.createManifest({
      workflowBundlePath,
      manifestDir: workflowGeneratedDir,
      manifest,
    });
  }

  private async buildStepsRoute({
    inputFiles,
    workflowGeneratedDir,
    tsPaths,
    tsBaseUrl,
  }: {
    inputFiles: string[];
    workflowGeneratedDir: string;
    tsBaseUrl?: string;
    tsPaths?: Record<string, string[]>;
  }) {
    // Create steps route: .well-known/workflow/v1/step/+server.js
    const stepsRouteDir = join(workflowGeneratedDir, 'step');
    await mkdir(stepsRouteDir, { recursive: true });

    const { manifest } = await this.createStepsBundle({
      format: 'esm',
      inputFiles,
      outfile: join(stepsRouteDir, '+server.js'),
      externalizeNonSteps: true,
      tsBaseUrl,
      tsPaths,
    });

    // Post-process the generated file to wrap with SvelteKit request converter
    const stepsRouteFile = join(stepsRouteDir, '+server.js');
    let stepsRouteContent = await readFile(stepsRouteFile, 'utf-8');

    // Replace the default export with SvelteKit-compatible handler
    stepsRouteContent = stepsRouteContent.replace(
      /export\s*\{\s*stepEntrypoint\s+as\s+POST\s*\}\s*;?$/m,
      `${NORMALIZE_REQUEST_CODE}
export const POST = async ({request}) => {
  const normalRequest = await normalizeRequest(request);
  return stepEntrypoint(normalRequest);
}`
    );

    await writeFile(stepsRouteFile, stepsRouteContent);
    return manifest;
  }

  private async buildWorkflowsRoute({
    inputFiles,
    workflowGeneratedDir,
    tsPaths,
    tsBaseUrl,
  }: {
    inputFiles: string[];
    workflowGeneratedDir: string;
    tsBaseUrl?: string;
    tsPaths?: Record<string, string[]>;
  }) {
    // Create workflows route: .well-known/workflow/v1/flow/+server.js
    const workflowsRouteDir = join(workflowGeneratedDir, 'flow');
    await mkdir(workflowsRouteDir, { recursive: true });

    await this.createWorkflowsBundle({
      format: 'esm',
      outfile: join(workflowsRouteDir, '+server.js'),
      bundleFinalOutput: false,
      inputFiles,
      tsBaseUrl,
      tsPaths,
    });

    // Post-process the generated file to wrap with SvelteKit request converter
    const workflowsRouteFile = join(workflowsRouteDir, '+server.js');
    let workflowsRouteContent = await readFile(workflowsRouteFile, 'utf-8');

    // Replace the default export with SvelteKit-compatible handler
    workflowsRouteContent = workflowsRouteContent.replace(
      /export const POST = workflowEntrypoint\(workflowCode\);?$/m,
      `${NORMALIZE_REQUEST_CODE}
export const POST = async ({request}) => {
  const normalRequest = await normalizeRequest(request);
  return workflowEntrypoint(workflowCode)(normalRequest);
}`
    );
    await writeFile(workflowsRouteFile, workflowsRouteContent);
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

  private async findRoutesDirectory(): Promise<string> {
    const routesDir = resolve(this.config.workingDir, 'src/routes');
    const rootRoutesDir = resolve(this.config.workingDir, 'routes');

    // Try src/routes first (standard SvelteKit convention)
    try {
      await access(routesDir, constants.F_OK);
      const routesStats = await stat(routesDir);
      if (!routesStats.isDirectory()) {
        throw new Error(`Path exists but is not a directory: ${routesDir}`);
      }
      return routesDir;
    } catch {
      // Try routes as fallback
      try {
        await access(rootRoutesDir, constants.F_OK);
        const rootRoutesStats = await stat(rootRoutesDir);
        if (!rootRoutesStats.isDirectory()) {
          throw new Error(
            `Path exists but is not a directory: ${rootRoutesDir}`
          );
        }
        return rootRoutesDir;
      } catch {
        throw new Error(
          'Could not find SvelteKit routes directory. Expected either "src/routes" or "routes" to exist.'
        );
      }
    }
  }
}
