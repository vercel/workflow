import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BaseBuilder } from '@workflow/builders';

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

export class LocalBuilder extends BaseBuilder {
  constructor() {
    super({
      dirs: ['.'],
      buildTarget: 'react-router' as const,
      stepsBundlePath: '',
      workflowsBundlePath: '',
      webhookBundlePath: '',
      workingDir: process.cwd(),
    });
  }

  override async build(): Promise<void> {
    const workflowGeneratedDir = resolve(
      this.config.workingDir,
      'app/routes/.workflow'
    );

    await mkdir(workflowGeneratedDir, { recursive: true });

    if (process.env.VERCEL_DEPLOYMENT_ID === undefined) {
      await writeFile(join(workflowGeneratedDir, '.gitignore'), '*');
    }

    const inputFiles = await this.getInputFiles();
    const tsConfig = await this.getTsConfigOptions();

    const options = {
      inputFiles,
      workflowGeneratedDir,
      tsBaseUrl: tsConfig.baseUrl,
      tsPaths: tsConfig.paths,
    };

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
    const stepsRouteFile = join(workflowGeneratedDir, 'step.ts');
    await this.createStepsBundle({
      format: 'esm',
      inputFiles,
      outfile: stepsRouteFile,
      externalizeNonSteps: true,
      tsBaseUrl,
      tsPaths,
    });

    let stepsRouteContent = await readFile(stepsRouteFile, 'utf-8');

    // Replace with react-router action export
    stepsRouteContent = stepsRouteContent.replace(
      /export\s*\{\s*stepEntrypoint\s+as\s+POST\s*\}\s*;?$/m,
      `${NORMALIZE_REQUEST_CONVERTER}
export async function action({ request }) {
  const normalRequest = await normalizeRequestConverter(request);
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
    const workflowsRouteFile = join(workflowGeneratedDir, 'flow.ts');
    await this.createWorkflowsBundle({
      format: 'esm',
      outfile: workflowsRouteFile,
      bundleFinalOutput: false,
      inputFiles,
      tsBaseUrl,
      tsPaths,
    });

    let workflowsRouteContent = await readFile(workflowsRouteFile, 'utf-8');

    // Replace with react-router action export
    workflowsRouteContent = workflowsRouteContent.replace(
      /export const POST = workflowEntrypoint\(workflowCode\);?$/m,
      `${NORMALIZE_REQUEST_CONVERTER}
export async function action({ request }) {
  const normalRequest = await normalizeRequestConverter(request);
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
    const webhookRouteFile = join(workflowGeneratedDir, 'webhook/[token].ts');

    await this.createWebhookBundle({
      outfile: webhookRouteFile,
      bundle: false,
    });

    let webhookRouteContent = await readFile(webhookRouteFile, 'utf-8');

    webhookRouteContent = webhookRouteContent.replace(
      /async function handler\(request\) \{[\s\S]*?const token = decodeURIComponent\(pathParts\[pathParts\.length - 1\]\);/,
      `async function handler(request, token) {`
    );

    webhookRouteContent = webhookRouteContent.replace(
      /const url = new URL\(request\.url\);[\s\S]*?const pathParts = url\.pathname\.split\('\/'\);[\s\S]*?\n/,
      ''
    );

    // Replace with react-router loader and action exports
    webhookRouteContent = webhookRouteContent.replace(
      /export const GET = handler;\nexport const POST = handler;\nexport const PUT = handler;\nexport const PATCH = handler;\nexport const DELETE = handler;\nexport const HEAD = handler;\nexport const OPTIONS = handler;/,
      `${NORMALIZE_REQUEST_CONVERTER}
// react-router uses loader for GET requests and action for mutations
export async function loader({ request, params }) {
  const normalRequest = await normalizeRequestConverter(request);
  return handler(normalRequest, params.token);
}

export async function action({ request, params }) {
  const normalRequest = await normalizeRequestConverter(request);
  return handler(normalRequest, params.token);
}`
    );

    await writeFile(webhookRouteFile, webhookRouteContent);
  }
}
