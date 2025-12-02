import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  BaseBuilder,
  VercelBuildOutputAPIBuilder,
  createBaseBuilderConfig,
  type AstroConfig,
} from '@workflow/builders';

// NOTE: This is the same as SvelteKit request converter, should merge
const NORMALIZE_REQUEST_CONVERTER = `
async function normalizeRequestConverter(request) {
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

const WORKFLOW_ROUTES = [
  {
    src: '^/\\.well-known/workflow/v1/flow/?$',
    dest: '/.well-known/workflow/v1/flow',
  },
  {
    src: '^/\\.well-known/workflow/v1/step/?$',
    dest: '/.well-known/workflow/v1/step',
  },
  {
    src: '^/\\.well-known/workflow/v1/webhook/([^/]+?)/?$',
    dest: '/.well-known/workflow/v1/webhook/[token]',
  },
];

export class LocalBuilder extends BaseBuilder {
  constructor() {
    super({
      dirs: ['src/pages', 'src/workflows'],
      buildTarget: 'astro' as const,
      stepsBundlePath: '', // unused in base
      workflowsBundlePath: '', // unused in base
      webhookBundlePath: '', // unused in base
      workingDir: process.cwd(),
      debugFilePrefix: '_', // Prefix with underscore so Astro ignores debug files
    });
  }

  override async build(): Promise<void> {
    const pagesDir = resolve(this.config.workingDir, 'src/pages');
    const workflowGeneratedDir = join(pagesDir, '.well-known/workflow/v1');

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

    // Generate the three Astro route handlers
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
    // Create steps route: .well-known/workflow/v1/step.js
    const stepsRouteFile = join(workflowGeneratedDir, 'step.js');
    await this.createStepsBundle({
      format: 'esm',
      inputFiles,
      outfile: stepsRouteFile,
      externalizeNonSteps: true,
      tsBaseUrl,
      tsPaths,
    });

    let stepsRouteContent = await readFile(stepsRouteFile, 'utf-8');

    // Normalize request, needed for preserving request through astro
    stepsRouteContent = stepsRouteContent.replace(
      /export\s*\{\s*stepEntrypoint\s+as\s+POST\s*\}\s*;?$/m,
      `${NORMALIZE_REQUEST_CONVERTER}
export const POST = async ({request}) => {
  const normalRequest = await normalizeRequestConverter(request);
  return stepEntrypoint(normalRequest);
}

export const prerender = false;`
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
    // Create workflows route: .well-known/workflow/v1/flow.js
    const workflowsRouteFile = join(workflowGeneratedDir, 'flow.js');
    await this.createWorkflowsBundle({
      format: 'esm',
      outfile: workflowsRouteFile,
      bundleFinalOutput: false,
      inputFiles,
      tsBaseUrl,
      tsPaths,
    });

    let workflowsRouteContent = await readFile(workflowsRouteFile, 'utf-8');

    // Normalize request, needed for preserving request through astro
    workflowsRouteContent = workflowsRouteContent.replace(
      /export const POST = workflowEntrypoint\(workflowCode\);?$/m,
      `${NORMALIZE_REQUEST_CONVERTER}
export const POST = async ({request}) => {
  const normalRequest = await normalizeRequestConverter(request);
  return workflowEntrypoint(workflowCode)(normalRequest);
}

export const prerender = false;`
    );
    await writeFile(workflowsRouteFile, workflowsRouteContent);
  }

  private async buildWebhookRoute({
    workflowGeneratedDir,
  }: {
    workflowGeneratedDir: string;
  }) {
    // Create webhook route: .well-known/workflow/v1/webhook/[token].js
    const webhookRouteFile = join(workflowGeneratedDir, 'webhook/[token].js');

    await this.createWebhookBundle({
      outfile: webhookRouteFile,
      bundle: false,
    });

    // Post-process the generated file to wrap with Astro request converter
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

    // Normalize request, needed for preserving request through astro
    webhookRouteContent = webhookRouteContent.replace(
      /export const GET = handler;\nexport const POST = handler;\nexport const PUT = handler;\nexport const PATCH = handler;\nexport const DELETE = handler;\nexport const HEAD = handler;\nexport const OPTIONS = handler;/,
      `${NORMALIZE_REQUEST_CONVERTER}
const createHandler = (method) => async ({ request, params, platform }) => {
  const normalRequest = await normalizeRequestConverter(request);
  const response = await handler(normalRequest, params.token);
  return response;
};

export const GET = createHandler('GET');
export const POST = createHandler('POST');
export const PUT = createHandler('PUT');
export const PATCH = createHandler('PATCH');
export const DELETE = createHandler('DELETE');
export const HEAD = createHandler('HEAD');
export const OPTIONS = createHandler('OPTIONS');

export const prerender = false;`
    );

    await writeFile(webhookRouteFile, webhookRouteContent);
  }
}

export class VercelBuilder extends VercelBuildOutputAPIBuilder {
  constructor(config?: Partial<AstroConfig>) {
    const workingDir = config?.workingDir || process.cwd();
    super({
      ...createBaseBuilderConfig({
        workingDir,
        dirs: ['src/pages', 'src/workflows'],
      }),
      buildTarget: 'vercel-build-output-api',
      debugFilePrefix: '_',
    });
  }

  override async build(): Promise<void> {
    const configPath = join(
      this.config.workingDir,
      '.vercel/output/config.json'
    );

    // The config output by astro
    const config = JSON.parse(await readFile(configPath, 'utf-8'));

    // Filter out existing workflow routes (wrong `dest` mapping)
    config.routes = config.routes.filter(
      (route: { src?: string; dest: string }) =>
        !route.src?.includes('.well-known/workflow')
    );

    // Find the index right after the "filesystem" handler and "continue: true" routes
    let insertIndex = config.routes.findIndex(
      (route: any) => route.handle === 'filesystem'
    );

    // Move past any routes with "continue: true" (like _astro cache headers)
    while (
      insertIndex < config.routes.length - 1 &&
      config.routes[insertIndex + 1]?.continue === true
    ) {
      insertIndex++;
    }

    // Insert workflow routes right after
    config.routes.splice(insertIndex + 1, 0, ...WORKFLOW_ROUTES);

    // Bundles workflows for vercel
    await super.build();

    // Use old astro config with updated routes
    await writeFile(configPath, JSON.stringify(config, null, 2));
  }
}
