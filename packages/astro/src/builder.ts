import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type AstroConfig,
  BaseBuilder,
  createBaseBuilderConfig,
  NORMALIZE_REQUEST_CODE,
  resolveProjectRoot,
  VercelBuildOutputAPIBuilder,
} from '@workflow/builders';

const WORKFLOW_ROUTES = [
  {
    src: '^/\\.well-known/workflow/v1/flow/?$',
    dest: '/.well-known/workflow/v1/flow',
  },
  {
    src: '^/\\.well-known/workflow/v1/webhook/([^/]+?)/?$',
    dest: '/.well-known/workflow/v1/webhook/[token]',
  },
];

export class LocalBuilder extends BaseBuilder {
  #pagesDir: string;

  constructor(options: Partial<AstroConfig> = {}) {
    const config = resolveAstroBuilderConfig(options);
    super({
      ...createBaseBuilderConfig({
        workingDir: config.workingDir,
        projectRoot: config.projectRoot,
        dirs: config.dirs,
        sourcemap: options.sourcemap,
      }),
      ...options,
      dirs: config.dirs,
      buildTarget: 'astro' as const,
      workingDir: config.workingDir,
      projectRoot: config.projectRoot,
      moduleSpecifierRoot: options.moduleSpecifierRoot ?? config.workingDir,
      debugFilePrefix: '_', // Prefix with underscore so Astro ignores debug files
    });
    this.#pagesDir = config.pagesDir;
  }

  override async build(): Promise<void> {
    const workflowGeneratedDir = join(
      this.#pagesDir,
      '.well-known/workflow/v1'
    );

    // Ensure output directories exist
    await mkdir(workflowGeneratedDir, { recursive: true });

    // Add .gitignore to exclude generated files from version control
    if (process.env.VERCEL_DEPLOYMENT_ID === undefined) {
      await writeFile(join(workflowGeneratedDir, '.gitignore'), '*');
    }

    // Clean up stale V1 step route (may persist via Vercel build cache)
    await rm(join(workflowGeneratedDir, 'step.js'), { force: true });

    // Get workflow and step files to bundle
    const inputFiles = await this.getInputFiles();
    const tsconfigPath = await this.findTsConfigPath();

    // Create combined bundle
    const { manifest } = await this.createCombinedBundle({
      inputFiles,
      stepsOutfile: join(workflowGeneratedDir, '__step_registrations.js'),
      flowOutfile: join(workflowGeneratedDir, 'flow.js'),
      format: 'esm',
      bundleFinalOutput: false,
      externalizeNonSteps: true,
      tsconfigPath,
    });

    // Post-process the generated file to wrap with Astro request converter
    const workflowsRouteFile = join(workflowGeneratedDir, 'flow.js');
    let workflowsRouteContent = await readFile(workflowsRouteFile, 'utf-8');

    // Normalize request, needed for preserving request through astro
    workflowsRouteContent = workflowsRouteContent.replace(
      /export const POST = workflowEntrypoint\(workflowCode(?<options>[^)]*)\);?$/m,
      (_match, options = '') => `${NORMALIZE_REQUEST_CODE}
export const POST = async ({request}) => {
  const normalRequest = await normalizeRequest(request);
  return workflowEntrypoint(workflowCode${options})(normalRequest);
}

export const prerender = false;`
    );
    await writeFile(workflowsRouteFile, workflowsRouteContent);

    await this.buildWebhookRoute({ workflowGeneratedDir });

    // Generate unified manifest
    const workflowBundlePath = join(workflowGeneratedDir, 'flow.js');
    const manifestJson = await this.createManifest({
      workflowBundlePath,
      manifestDir: workflowGeneratedDir,
      manifest,
    });

    // Expose manifest as a public HTTP route when WORKFLOW_PUBLIC_MANIFEST=1
    // Astro maps `foo.json.js` to the URL `/foo.json`
    if (this.shouldExposePublicManifest && manifestJson) {
      await writeFile(
        join(workflowGeneratedDir, 'manifest.json.js'),
        `export function GET() {
  return new Response(${JSON.stringify(manifestJson)}, {
    headers: { "content-type": "application/json" },
  });
}

export const prerender = false;\n`
      );
    }
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
      `${NORMALIZE_REQUEST_CODE}
const createHandler = (method) => async ({ request, params, platform }) => {
  const normalRequest = await normalizeRequest(request);
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
  constructor(options: Partial<AstroConfig> = {}) {
    const config = resolveAstroBuilderConfig(options);
    super({
      ...createBaseBuilderConfig({
        workingDir: config.workingDir,
        projectRoot: config.projectRoot,
        dirs: config.dirs,
        runtime: options.runtime,
        sourcemap: options.sourcemap,
      }),
      ...options,
      dirs: config.dirs,
      buildTarget: 'vercel-build-output-api',
      workingDir: config.workingDir,
      projectRoot: config.projectRoot,
      moduleSpecifierRoot: options.moduleSpecifierRoot ?? config.workingDir,
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

function resolveAstroBuilderConfig(options: Partial<AstroConfig> = {}): {
  workingDir: string;
  pagesDir: string;
  dirs: string[];
  projectRoot: string;
} {
  const workingDir = resolve(options.workingDir ?? process.cwd());
  const dirs = options.dirs ?? ['src/pages', 'src/workflows'];
  const pagesDir = resolve(workingDir, dirs[0]);

  return {
    workingDir,
    pagesDir,
    dirs,
    projectRoot: options.projectRoot ?? resolveProjectRoot(workingDir),
  };
}
