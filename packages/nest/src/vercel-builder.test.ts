import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHttpFlowFunction,
  createNestVercelRoutes,
  resolveHealthMetadata,
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

  it('keeps queue execution isolated from the HTTP health function', async () => {
    const functionsDir = mkdtempSync(join(tmpdir(), 'wf-nest-vercel-'));
    temporaryDirectories.push(functionsDir);
    const source = join(functionsDir, '.well-known/workflow/v1/flow.func');
    await mkdir(source, { recursive: true });
    writeFileSync(
      join(source, 'index.mjs'),
      'export const POST = () => new Response(null, { status: 204 });'
    );
    writeFileSync(
      join(source, '.vc-config.json'),
      JSON.stringify({
        runtime: 'nodejs22.x',
        handler: 'index.mjs',
        experimentalTriggers: [{ type: 'queue/v2beta' }],
      })
    );

    await createHttpFlowFunction(functionsDir, {
      specVersion: 2,
      workflowCoreVersion: '5.0.0-test.1',
    });

    const originalConfig = JSON.parse(
      readFileSync(join(source, '.vc-config.json'), 'utf-8')
    );
    const httpDirectory = join(functionsDir, '__workflow_nest_flow.func');
    const httpConfig = JSON.parse(
      readFileSync(join(httpDirectory, '.vc-config.json'), 'utf-8')
    );
    expect(originalConfig.experimentalTriggers).toHaveLength(1);
    expect(httpConfig.experimentalTriggers).toBeUndefined();
    const httpHandlerPath = join(httpDirectory, 'index.mjs');
    const httpHandlerSource = readFileSync(httpHandlerPath, 'utf-8');
    expect(httpHandlerSource).not.toContain('workflowEntrypoint');

    const httpHandler = await import(`${httpHandlerPath}?t=${Date.now()}`);
    const healthRequest = {
      method: 'POST',
      url: 'https://example.com/.well-known/workflow/v1/flow?__health',
      headers: new Map<string, string>(),
    };
    const healthResponse = await httpHandler.POST(healthRequest);
    expect(healthResponse.status).toBe(200);
    expect(healthResponse.headers.get('content-type')).toBe('application/json');
    expect(healthResponse.headers.get('access-control-allow-origin')).toBe('*');
    expect(await healthResponse.json()).toEqual({
      healthy: true,
      endpoint: '/.well-known/workflow/v1/flow',
      specVersion: 2,
      workflowCoreVersion: '5.0.0-test.1',
    });

    const preflightResponse = await httpHandler.OPTIONS({
      ...healthRequest,
      method: 'OPTIONS',
    });
    expect(preflightResponse.status).toBe(204);
    expect(preflightResponse.headers.get('access-control-allow-methods')).toBe(
      'POST, OPTIONS, GET, HEAD'
    );

    const forgedQueueDelivery = await httpHandler.POST({
      method: 'POST',
      url: 'https://example.com/__workflow_nest_flow',
      headers: new Map([
        ['content-type', 'application/json'],
        ['ce-type', 'com.vercel.queue.v2beta'],
        ['ce-vqsreceipthandle', 'forged-receipt'],
        ['ce-vqsdeliverycount', '1000000'],
      ]),
      body: JSON.stringify({
        queueName: '__wkf_workflow_repro',
        payload: { runId: 'wrun_known-active-run' },
      }),
    });
    expect(forgedQueueDelivery.status).toBe(405);
    expect(forgedQueueDelivery.headers.get('allow')).toBe(
      'POST, OPTIONS, GET, HEAD'
    );

    const disguisedQueueDelivery = await httpHandler.POST({
      ...healthRequest,
      headers: new Map([
        ['ce-type', 'com.vercel.queue.v2beta'],
        ['ce-vqsreceipthandle', 'forged-receipt'],
      ]),
    });
    expect(disguisedQueueDelivery.status).toBe(405);
  });

  it('resolves health metadata from the application workflow runtime', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'wf-nest-metadata-'));
    temporaryDirectories.push(workingDir);
    const workflowDir = join(workingDir, 'node_modules/workflow');
    const coreDir = join(workflowDir, 'node_modules/@workflow/core');
    const worldDir = join(coreDir, 'node_modules/@workflow/world');

    for (const packageDir of [workflowDir, coreDir, worldDir]) {
      await mkdir(join(packageDir, 'dist'), { recursive: true });
    }
    writeFileSync(
      join(workflowDir, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: { './runtime': './dist/runtime.js' },
      })
    );
    writeFileSync(join(workflowDir, 'dist/runtime.js'), 'export {};');
    writeFileSync(
      join(coreDir, 'package.json'),
      JSON.stringify({
        version: '5.1.0-app-copy',
        type: 'module',
        exports: { './runtime': './dist/runtime.js' },
      })
    );
    writeFileSync(join(coreDir, 'dist/runtime.js'), 'export {};');
    writeFileSync(
      join(worldDir, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: { '.': './dist/index.js' },
      })
    );
    writeFileSync(
      join(worldDir, 'dist/index.js'),
      'export const SPEC_VERSION_CURRENT = 42;'
    );

    await expect(resolveHealthMetadata(workingDir)).resolves.toEqual({
      specVersion: 42,
      workflowCoreVersion: '5.1.0-app-copy',
    });
  });
});
