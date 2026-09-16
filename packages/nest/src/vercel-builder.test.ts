import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHttpFlowFunction,
  createNestVercelRoutes,
} from './vercel-builder.js';

const existingWebhookRoute = {
  src: '^\\/\\.well-known\\/workflow\\/v1\\/webhook\\/([^\\/]+)$',
  dest: '/.well-known/workflow/v1/webhook/[token]',
};

describe('createNestVercelRoutes', () => {
  it('routes the public flow function before the Nest catch-all', () => {
    expect(createNestVercelRoutes([existingWebhookRoute], '__nest')).toEqual([
      existingWebhookRoute,
      { handle: 'filesystem' },
      {
        src: '/\\.well-known/workflow/v1/flow',
        dest: '/__workflow_nest_flow',
      },
      { src: '/(.*)', dest: '/__nest', check: true },
    ]);
  });

  it('rewrites prefixed flow and webhook URLs to dedicated functions', () => {
    expect(
      createNestVercelRoutes([existingWebhookRoute], 'app', 'api/v2/')
    ).toEqual([
      existingWebhookRoute,
      { handle: 'filesystem' },
      {
        src: '/api/v2/\\.well-known/workflow/v1/flow',
        dest: '/__workflow_nest_flow',
      },
      {
        src: '/api/v2/\\.well-known/workflow/v1/webhook/([^/]+)',
        dest: '/.well-known/workflow/v1/webhook/[token]',
      },
      { src: '/(.*)', dest: '/app', check: true },
    ]);
  });

  it('escapes regex characters in the base path', () => {
    const [, flow] = createNestVercelRoutes([], '__nest', '/api.v2');
    expect(flow).toEqual({
      src: '/api\\.v2/\\.well-known/workflow/v1/flow',
      dest: '/__workflow_nest_flow',
    });
  });
});

describe('createHttpFlowFunction', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the queue consumer trigger only on the original function', async () => {
    const functionsDir = mkdtempSync(join(tmpdir(), 'wf-nest-vercel-'));
    temporaryDirectories.push(functionsDir);
    const source = join(functionsDir, '.well-known/workflow/v1/flow.func');
    await mkdir(source, { recursive: true });
    writeFileSync(join(source, 'index.mjs'), 'export const GET = () => {};');
    writeFileSync(
      join(source, '.vc-config.json'),
      JSON.stringify({
        runtime: 'nodejs22.x',
        handler: 'index.mjs',
        experimentalTriggers: [{ type: 'queue/v2beta' }],
      })
    );

    await createHttpFlowFunction(functionsDir);

    const originalConfig = JSON.parse(
      readFileSync(join(source, '.vc-config.json'), 'utf-8')
    );
    const httpDirectory = join(functionsDir, '__workflow_nest_flow.func');
    const httpConfig = JSON.parse(
      readFileSync(join(httpDirectory, '.vc-config.json'), 'utf-8')
    );
    expect(originalConfig.experimentalTriggers).toHaveLength(1);
    expect(httpConfig.experimentalTriggers).toBeUndefined();
    expect(readFileSync(join(httpDirectory, 'index.mjs'), 'utf-8')).toContain(
      'export const GET'
    );
  });
});
