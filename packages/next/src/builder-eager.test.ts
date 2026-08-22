import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as buildersModule from '@workflow/builders';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNextEntrypointMatcher,
  getNextBuilderEager,
} from './builder-eager.js';

const pageExtensions = ['js', 'jsx', 'ts', 'tsx', 'mts', 'cts'];
const isNextEntrypoint = createNextEntrypointMatcher(pageExtensions);

describe('isNextEntrypoint', () => {
  it.each([
    'pages/index.tsx',
    'pages/api/run.ts',
    'src/pages/api/run.ts',
    'app/page.tsx',
    'app/dashboard/error.tsx',
    'app/@modal/default.tsx',
    'app/blog/opengraph-image1.tsx',
    'app/global-error.tsx',
    'app/robots.ts',
    'src/app/robots.ts',
    'instrumentation.ts',
    'instrumentation-client.ts',
    'instrumentation-client.mjs',
    'proxy.ts',
    'mdx-components.tsx',
    'mdx-components.mjs',
    'src/instrumentation-client.ts',
    'src/mdx-components.tsx',
  ])('includes %s', (entry) => {
    expect(isNextEntrypoint(entry)).toBe(true);
  });

  it.each([
    'app/component.tsx',
    'app/error.test.tsx',
    'app/_components/error.tsx',
    'app/blog/global-error.tsx',
    'app/blog/robots.ts',
    'app/blog/opengraph-image12.tsx',
    'pages/types.d.ts',
    'pages/types.d.mts',
    'pages/types.d.cts',
    'app/page.d.ts',
    'app/page.vue',
  ])('excludes %s', (entry) => {
    expect(isNextEntrypoint(entry)).toBe(false);
  });

  it('supports compound page extensions', () => {
    expect(
      createNextEntrypointMatcher(['tsx', 'page.tsx'])('app/error.page.tsx')
    ).toBe(true);
  });
});

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

async function writeWorkflowRuntimeStub(workingDir: string): Promise<void> {
  const packageDir = join(workingDir, 'node_modules/workflow');
  await write(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: 'workflow',
      version: '1.0.0',
      type: 'module',
      exports: {
        './api': './api.js',
        './internal/builtins': './builtins.js',
        './runtime': './runtime.js',
      },
    })
  );
  await write(
    join(packageDir, 'api.js'),
    'export async function resumeWebhook() { return new Response(null, { status: 204 }); }\n'
  );
  await write(
    join(packageDir, 'builtins.js'),
    'export const __workflow_builtins = true;\n'
  );
  await write(
    join(packageDir, 'runtime.js'),
    'export function workflowEntrypoint() { return async function POST() { return new Response(null, { status: 204 }); }; }\n'
  );
}

describe('NextBuilder onAfterBundle integration', () => {
  let workingDir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (workingDir) {
      rmSync(workingDir, { recursive: true, force: true });
      workingDir = undefined;
    }
  });

  it('invokes the hook through the real Next manifest path', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    workingDir = mkdtempSync(join(tmpdir(), 'workflow-next-after-bundle-'));
    await writeWorkflowRuntimeStub(workingDir);
    await write(
      join(workingDir, 'app/page.tsx'),
      `export async function exampleStep(): Promise<string> {
  'use step';
  return 'ok';
}

export async function exampleWorkflow(): Promise<string> {
  'use workflow';
  return exampleStep();
}

export default function Page() {
  return null;
}
`
    );

    const onAfterBundle = vi.fn();
    const NextBuilder = await getNextBuilderEager(buildersModule);
    const builder = new NextBuilder({
      watch: false,
      dirs: ['.'],
      pageExtensions: ['tsx', 'ts', 'jsx', 'js'],
      projectRoot: workingDir,
      moduleSpecifierRoot: workingDir,
      workingDir,
      distDir: '.next',
      buildTarget: 'next',
      workflowsBundlePath: '',
      stepsBundlePath: '',
      webhookBundlePath: '',
      suppressCreateManifestLogs: true,
      suppressCreateWebhookBundleLogs: true,
      suppressCreateWorkflowsBundleLogs: true,
      onAfterBundle,
    });

    await builder.build();

    expect(onAfterBundle).toHaveBeenCalledOnce();
    const result = onAfterBundle.mock.calls[0][0];
    expect(result.buildTarget).toBe('next');
    expect(
      result.artifacts.every(({ path }: { path: string }) => existsSync(path))
    ).toBe(true);
    expect(result.artifacts.map(({ kind }: { kind: string }) => kind)).toEqual([
      'steps',
      'workflows',
      'manifest',
    ]);
  });
});
