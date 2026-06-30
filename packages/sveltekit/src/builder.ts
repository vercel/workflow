import { constants, existsSync, readFileSync } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  BaseBuilder,
  createBaseBuilderConfig,
  NORMALIZE_REQUEST_CODE,
  type SvelteKitConfig,
} from '@workflow/builders';

const SVELTEKIT_VIRTUAL_MODULES = [
  '$env/*', // All $env subpaths
  '$lib', // Exact $lib import
  '$lib/*', // All $lib subpaths
  '$app/*', // All $app subpaths
];

type SvelteKitBuilderConfig = Partial<SvelteKitConfig> & {
  routesDir?: string;
};

export class SvelteKitBuilder extends BaseBuilder {
  #routesDir: string | undefined;

  constructor(config: SvelteKitBuilderConfig = {}) {
    const workingDir = resolve(config.workingDir || process.cwd());
    const routesDir = config.routesDir
      ? resolve(workingDir, config.routesDir)
      : undefined;
    const dirs = config.dirs ?? getSvelteKitWorkflowDirs(workingDir, routesDir);
    const projectRoot = config.projectRoot ?? findWorkspaceRoot(workingDir);
    super({
      ...createBaseBuilderConfig({
        workingDir,
        projectRoot,
        dirs,
        externalPackages: [...SVELTEKIT_VIRTUAL_MODULES],
        sourcemap: config.sourcemap,
      }),
      ...config,
      dirs,
      buildTarget: 'sveltekit' as const,
      stepsBundlePath: '',
      workflowsBundlePath: '',
      webhookBundlePath: '',
      workingDir,
      projectRoot,
      externalPackages: [...SVELTEKIT_VIRTUAL_MODULES],
      sourcemap: config.sourcemap,
    });
    this.#routesDir = routesDir;
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
export const POST = async ({request}) => {
  const normalRequest = await normalizeRequest(request);
  return workflowEntrypoint(workflowCode${options})(normalRequest);
}`
    );
    await writeFile(workflowsRouteFile, workflowsRouteContent);

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
        await writeFile(join(staticManifestDir, '.gitignore'), '*');
      }
      await copyFile(
        join(workflowGeneratedDir, 'manifest.json'),
        join(staticManifestDir, 'manifest.json')
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
    if (this.#routesDir) {
      await assertDirectory(this.#routesDir);
      return this.#routesDir;
    }

    const routesDir = resolve(this.config.workingDir, 'src/routes');
    const rootRoutesDir = resolve(this.config.workingDir, 'routes');

    // Try src/routes first (standard SvelteKit convention)
    try {
      await assertDirectory(routesDir);
      return routesDir;
    } catch {
      // Try routes as fallback
      try {
        await assertDirectory(rootRoutesDir);
        return rootRoutesDir;
      } catch {
        throw new Error(
          'Could not find SvelteKit routes directory. Expected either "src/routes" or "routes" to exist.'
        );
      }
    }
  }
}

async function assertDirectory(path: string): Promise<void> {
  await access(path, constants.F_OK);
  const stats = await stat(path);
  if (!stats.isDirectory()) {
    throw new Error(`Path exists but is not a directory: ${path}`);
  }
}

function getSvelteKitWorkflowDirs(
  workingDir: string,
  routesDir: string | undefined
): string[] {
  return [
    'workflows',
    'src/workflows',
    ...(routesDir
      ? [toBuilderDir(workingDir, routesDir)]
      : ['routes', 'src/routes']),
  ];
}

function toBuilderDir(workingDir: string, dir: string): string {
  const relativeDir = relative(workingDir, dir);
  if (
    relativeDir &&
    !relativeDir.startsWith('..') &&
    !isAbsolute(relativeDir)
  ) {
    return toPosixPath(relativeDir);
  }
  return dir;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function findWorkspaceRoot(workingDir: string): string {
  let current = resolve(workingDir);

  while (true) {
    if (
      existsSync(join(current, 'pnpm-workspace.yaml')) ||
      packageJsonHasWorkspaces(join(current, 'package.json'))
    ) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return workingDir;
    }
    current = parent;
  }
}

function packageJsonHasWorkspaces(path: string): boolean {
  try {
    const packageJson = JSON.parse(readFileSync(path, 'utf-8')) as {
      workspaces?: unknown;
    };
    return packageJson.workspaces !== undefined;
  } catch {
    return false;
  }
}
