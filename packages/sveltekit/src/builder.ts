import { constants } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BaseBuilder, type SvelteKitConfig } from '@workflow/builders';

// Helper function code for converting SvelteKit requests to standard Request objects
const SVELTEKIT_REQUEST_CONVERTER = `
async function convertSvelteKitRequest(request) {
  const options = {
    method: request.method,
    headers: new Headers(request.headers)
  };
  if (!['GET', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'].includes(request.method)) {
    options.body = await request.arrayBuffer();
  }
  return new Request(request.url, options);
}
`;

export class SvelteKitBuilder extends BaseBuilder {
  constructor(config?: Partial<SvelteKitConfig>) {
    const workingDir = config?.workingDir || process.cwd();

    super({
      ...config,
      dirs: ['src/routes', 'src/lib'],
      buildTarget: 'sveltekit' as const,
      stepsBundlePath: '', // unused in base
      workflowsBundlePath: '', // unused in base
      webhookBundlePath: '', // unused in base
      workingDir,
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
    await this.buildStepsRoute(options);
    await this.buildWorkflowsRoute(options);
    await this.buildWebhookRoute({ workflowGeneratedDir });
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

    await this.createStepsBundle({
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
      `${SVELTEKIT_REQUEST_CONVERTER}
export const POST = async ({request}) => {
  const normalRequest = await convertSvelteKitRequest(request);
  return stepEntrypoint(normalRequest);
}`
    );

    await writeFile(stepsRouteFile, stepsRouteContent);
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
      `${SVELTEKIT_REQUEST_CONVERTER}
export const POST = async ({request}) => {
  const normalRequest = await convertSvelteKitRequest(request);
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

    // NOTE: This is a workaround to avoid crashing in local dev when context isn't set for waitUntil()
    webhookRouteContent = `process.on('unhandledRejection', (reason) => { if (reason !== undefined) console.error('Unhandled rejection detected', reason); });
${webhookRouteContent}`;

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
      `${SVELTEKIT_REQUEST_CONVERTER}
const createSvelteKitHandler = (method) => async ({ request, params, platform }) => {
  const normalRequest = await convertSvelteKitRequest(request);
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
