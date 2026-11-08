import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IN_PROCESS_QUEUE_HANDLER } from '@workflow/world';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkflowWorkerModuleCode } from './worker-module.js';

/**
 * The generated worker module: `registerWorkflowWorker()` hands the route to
 * the World, `startWorkflowWorker()` also starts it. With `reloads` the
 * registered handler imports the route on every delivery.
 */
describe('createWorkflowWorkerModuleCode', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  async function load(options: { wrapped?: boolean; reloads?: boolean }) {
    const dir = await mkdtemp(join(tmpdir(), 'worker-module-'));
    dirs.push(dir);
    // The route module, versioned so a test can rebuild it.
    const writeRoute = (version: number) =>
      writeFile(
        join(dir, 'route.js'),
        `const entry = Symbol.for(${JSON.stringify(IN_PROCESS_QUEUE_HANDLER.description)});
export const POST = Object.assign(
  async (arg) => new Response('http ' + ${version} + ' ' + (arg instanceof Request ? 'request' : 'event')),
  { [entry]: async (delivery) => 'in-process ' + ${version} + ' ' + delivery.meta.messageId }
);
`
      );
    await writeRoute(1);
    // Stands in for `workflow/runtime`.
    const runtime = join(dir, 'runtime.mjs');
    await writeFile(
      runtime,
      `export const registered = [];
export const started = [];
export async function registerWorkflowHandler(route, options) { registered.push({ route, options }); return true; }
export async function getWorld() { return { async start() { started.push('start'); } }; }
`
    );
    const code = createWorkflowWorkerModuleCode({
      routeSpecifier: './route.js',
      ...options,
    }).replace(
      "'workflow/runtime'",
      JSON.stringify(pathToFileURL(runtime).href)
    );
    const worker = join(dir, 'worker.mjs');
    await writeFile(worker, code);
    return {
      worker: await import(pathToFileURL(worker).href),
      runtime: await import(pathToFileURL(runtime).href),
      writeRoute,
    };
  }

  it('registers the route itself and starts the World', async () => {
    const { worker, runtime } = await load({});
    await worker.startWorkflowWorker();
    expect(runtime.registered).toHaveLength(1);
    expect(runtime.registered[0].options).toBeUndefined();
    expect(runtime.started).toEqual(['start']);
    const route = runtime.registered[0].route;
    expect(await (await route(new Request('http://x/'))).text()).toBe(
      'http 1 request'
    );
    expect(
      await route[IN_PROCESS_QUEUE_HANDLER]({
        message: {},
        meta: { messageId: 'msg_1' },
      })
    ).toBe('in-process 1 msg_1');
  });

  it('with reloads, registers a handler that loads the route on every delivery', async () => {
    const { worker, runtime } = await load({ reloads: true, wrapped: true });
    await worker.registerWorkflowWorker();
    expect(runtime.started).toEqual([]);
    const [{ route, options }] = runtime.registered;
    expect(options).toEqual({ reloads: true });
    expect(
      await route[IN_PROCESS_QUEUE_HANDLER]({
        message: {},
        meta: { messageId: 'msg_2' },
      })
    ).toBe('in-process 1 msg_2');
    // A wrapped route takes the framework's `{ request }` event.
    expect(await (await route(new Request('http://x/'))).text()).toBe(
      'http 1 event'
    );
  });
});
