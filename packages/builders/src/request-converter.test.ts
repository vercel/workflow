import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IN_PROCESS_QUEUE_HANDLER } from '@workflow/world';
import { afterEach, describe, expect, it } from 'vitest';
import { createWrappedWorkflowRouteCode } from './request-converter.js';

/**
 * The flow route SvelteKit and Astro serve: `workflowEntrypoint()` once for
 * the module, a `POST` that takes `{ request }`, and the entrypoint's
 * in-process entry on `POST` so a World handed the module's `POST` delivers
 * in process.
 */
describe('createWrappedWorkflowRouteCode', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  async function load(trailer?: string) {
    const dir = await mkdtemp(join(tmpdir(), 'wrapped-route-'));
    dirs.push(dir);
    const file = join(dir, 'route.mjs');
    // Stands in for `workflowEntrypoint`: records what it is called with and
    // what it serves, and carries an in-process entry as the real one does.
    await writeFile(
      file,
      `export const calls = [];
export const served = [];
const entry = Symbol.for(${JSON.stringify(IN_PROCESS_QUEUE_HANDLER.description)});
function workflowEntrypoint(code, options) {
  calls.push({ code, options });
  const route = async (req) => {
    served.push(req);
    return new Response('served');
  };
  Object.defineProperty(route, entry, { value: 'in-process entry', enumerable: false });
  return route;
}
const workflowCode = 'code';
${createWrappedWorkflowRouteCode('workflowEntrypoint(workflowCode, { namespace: "ns" })', trailer)}
`
    );
    return import(pathToFileURL(file).href);
  }

  it('builds the entrypoint once and serves normalized requests', async () => {
    const mod = await load();
    expect(mod.calls).toEqual([{ code: 'code', options: { namespace: 'ns' } }]);
    const request = new Request('http://app.test/flow', {
      method: 'POST',
      body: 'payload',
      headers: { 'x-test': '1' },
    });
    const response = await mod.POST({ request });
    expect(await response.text()).toBe('served');
    expect(mod.calls).toHaveLength(1);
    expect(mod.served).toHaveLength(1);
    expect(mod.served[0]).not.toBe(request);
    expect(mod.served[0].headers.get('x-test')).toBe('1');
    expect(await mod.served[0].text()).toBe('payload');
  });

  it("exposes the entrypoint's in-process entry on POST", async () => {
    const mod = await load();
    expect(mod.POST[IN_PROCESS_QUEUE_HANDLER]).toBe('in-process entry');
  });

  it('appends the trailer', async () => {
    const mod = await load('\nexport const prerender = false;');
    expect(mod.prerender).toBe(false);
  });
});
