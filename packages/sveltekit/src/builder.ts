import { constants } from 'node:fs';
import { access, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  BaseBuilder,
  createBaseBuilderConfig,
  NORMALIZE_REQUEST_CODE,
  resolveProjectRoot,
  type SvelteKitConfig,
  writeFileIfChanged,
} from '@workflow/builders';

const SVELTEKIT_VIRTUAL_MODULES = [
  '$env/*', // All $env subpaths
  '$lib', // Exact $lib import
  '$lib/*', // All $lib subpaths
  '$app/*', // All $app subpaths
];

export class SvelteKitBuilder extends BaseBuilder {
  #routesDir: string;

  constructor(config: Partial<SvelteKitConfig> & { routesDir?: string } = {}) {
    const workingDir = resolve(config.workingDir || process.cwd());
    const dirs = config.dirs ?? [
      'workflows',
      'src/workflows',
      'routes',
      'src/routes',
    ];
    const projectRoot = config.projectRoot ?? resolveProjectRoot(workingDir);
    const routesDir = resolve(workingDir, config.routesDir ?? 'src/routes');
    super({
      ...createBaseBuilderConfig({
        workingDir,
        projectRoot,
        dirs,
        watch: config.watch,
        externalPackages: [...SVELTEKIT_VIRTUAL_MODULES],
        sourcemap: config.sourcemap,
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
      await writeFileIfChanged(join(workflowGeneratedDir, '.gitignore'), '*');
    }

    // Clean up stale V1 step route directory (may persist via Vercel build cache)
    await rm(join(workflowGeneratedDir, 'step'), {
      recursive: true,
      force: true,
    });

    // Get workflow and step files to bundle
    const inputFiles = await this.getInputFiles();
    const tsconfigPath = await this.findTsConfigPath();

    // Create combined bundle for flow route
    const flowRouteDir = join(workflowGeneratedDir, 'flow');
    await mkdir(flowRouteDir, { recursive: true });

    const { manifest } = await this.createCombinedBundle({
      inputFiles,
      stepsOutfile: join(flowRouteDir, '__step_registrations.js'),
      flowOutfile: join(flowRouteDir, '+server.js'),
      format: 'esm',
      bundleFinalOutput: false,
      externalizeNonSteps: true,
      tsconfigPath,
    });

    // Post-process the generated file to wrap with SvelteKit request converter
    const workflowsRouteFile = join(flowRouteDir, '+server.js');
    let workflowsRouteContent = await readFile(workflowsRouteFile, 'utf-8');

    // Replace the default export with SvelteKit-compatible handler
    workflowsRouteContent = workflowsRouteContent.replace(
      /export const POST = workflowEntrypoint\(workflowCode(?<options>[^)]*)\);?$/m,
      (_match, options = '') => `${NORMALIZE_REQUEST_CODE}
const workflowHandler = workflowEntrypoint(workflowCode${options});

export const POST = async ({request}) => {
  const normalRequest = await normalizeRequest(request);
  return workflowHandler(normalRequest);
}`
    );
    // These files are generated into the SvelteKit routes directory, which
    // Vite watches in dev, so an identical rewrite would still invalidate the
    // module and force a redundant recompile.
    await writeFileIfChanged(workflowsRouteFile, workflowsRouteContent);

    await this.buildWebhookRoute({ workflowGeneratedDir });

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
        await writeFileIfChanged(join(staticManifestDir, '.gitignore'), '*');
      }
      // Written from the same string rather than copied, so an unchanged
      // manifest leaves the static copy untouched too.
      await writeFileIfChanged(
        join(staticManifestDir, 'manifest.json'),
        manifestJson
      );
    }
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

    // Replace all HTTP method exports with SvelteKit-compatible handlers.
    // The `request` from SvelteKit is already a standard `Request`, so it is
    // handed to the webhook handler as-is. Notably it must NOT be copied via
    // a normalizer that buffers the body: this is a public route where the
    // token is checked inside `handler`, so the body must stay unread until
    // the token has been accepted.
    webhookRouteContent = webhookRouteContent.replace(
      /export const GET = handler;\nexport const POST = handler;\nexport const PUT = handler;\nexport const PATCH = handler;\nexport const DELETE = handler;\nexport const HEAD = handler;\nexport const OPTIONS = handler;/,
      `const createSvelteKitHandler = (method) => async ({ request, params, platform }) => {
  const response = await handler(request, params.token);
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

    await writeFileIfChanged(webhookRouteFile, webhookRouteContent);
  }

  private async loadRoutesDirectory(): Promise<string> {
    await assertDirectory(this.#routesDir);
    return this.#routesDir;
  }
}

async function assertDirectory(path: string): Promise<void> {
  await access(path, constants.F_OK);
  const stats = await stat(path);
  if (!stats.isDirectory()) {
    throw new Error(`Path exists but is not a directory: ${path}`);
  }
}
