import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createNextEntrypointMatcher,
  getNextBuilderEager,
} from './builder-eager.js';

it('generates an HTTP invocation route that delegates to the execution handler without a queue trigger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-invoke-route-'));
  try {
    const workflowGeneratedDir = join(directory, '.well-known/workflow/v1');
    await mkdir(join(workflowGeneratedDir, 'flow'), { recursive: true });
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(
      join(workflowGeneratedDir, 'flow/route.js'),
      'export async function POST(request) { return new Response(await request.text()); }'
    );
    const Builder = await getNextBuilderEager(
      await import('@workflow/builders')
    );
    const builder = new Builder({ workingDir: directory });
    await builder.buildInvocationRoute({ workflowGeneratedDir });
    await builder.writeFunctionsConfig(directory);
    const { POST } = await import(
      pathToFileURL(join(workflowGeneratedDir, 'invoke/route.js')).href
    );
    const response = await POST(
      new Request('https://example.test/.well-known/workflow/v1/invoke', {
        method: 'POST',
        body: 'invocation body',
      })
    );
    expect(await response.text()).toBe('invocation body');
    const config = JSON.parse(
      await readFile(join(workflowGeneratedDir, 'config.json'), 'utf8')
    );
    expect(Object.keys(config)).toEqual(['version', 'workflows']);
    expect(config.workflows.experimentalTriggers).toHaveLength(1);
    expect(config.invoke).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
