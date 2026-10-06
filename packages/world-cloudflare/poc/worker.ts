/**
 * POC Worker: a tiny HTTP API over the Workflow SDK, running on the
 * Durable Objects World. Used by `poc/test/e2e.test.ts` under `wrangler dev`.
 */

import encoding from 'quickjs-wasi/encoding.so';
import headers from 'quickjs-wasi/headers.so';
import quickjs from 'quickjs-wasi/quickjs.wasm';
import structuredClone from 'quickjs-wasi/structured-clone.so';
import url from 'quickjs-wasi/url.so';
import { getRun, resumeHook, start } from 'workflow/api';
import { healthCheck, setWorld } from 'workflow/runtime';
import { setupCloudflareWorld } from '../src/index.js';
import { deploymentId, workflowIds } from './.workflow/build-info.mjs';
import { createFlowRoute } from './.workflow/combined.mjs';

export {
  RunObject,
  StepRunner,
  StreamObject,
  TokenObject,
} from '../src/index.js';

const world = setupCloudflareWorld({
  deploymentId,
  createFlowRoute,
  quickjs: { quickjs, encoding, headers, url, structuredClone },
  setWorld,
});

interface Env {
  WORKFLOW_RUNS: { getByName(name: string): any };
}

const json = (value: unknown, status = 200) =>
  new Response(
    JSON.stringify(value, (_key, v) =>
      v instanceof Uint8Array ? `<${v.byteLength}B>` : v
    ),
    { status, headers: { 'content-type': 'application/json' } }
  );

async function withTimeout<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    const parts = pathname.split('/').filter(Boolean);
    try {
      if (request.method === 'POST' && pathname === '/start') {
        const body = (await request.json()) as {
          workflow: string;
          args?: unknown[];
        };
        const workflowId = (workflowIds as Record<string, string>)[
          body.workflow
        ];
        if (!workflowId) return json({ error: 'unknown workflow' }, 404);
        const run = await start({ workflowId } as never, body.args ?? []);
        return json({ runId: run.runId });
      }

      if (parts[0] === 'runs' && parts[1]) {
        const runId = parts[1];
        if (request.method === 'GET' && parts.length === 2) {
          const run = getRun(runId);
          const waitMs = Number(searchParams.get('wait') ?? '0');
          if (waitMs > 0) {
            const value = await withTimeout(run.returnValue, waitMs).catch(
              (error: Error) => ({ error: error.message })
            );
            if (value !== 'timeout') {
              return json({ status: await run.status, value });
            }
          }
          return json({ status: await run.status });
        }
        if (request.method === 'GET' && parts[2] === 'events') {
          const page = await world.events.list({
            runId,
            pagination: { limit: 1000, sortOrder: 'asc' },
            resolveData: searchParams.has('full') ? 'all' : 'none',
          });
          return json(
            page.data.map((e) => ({
              eventId: e.eventId,
              eventType: e.eventType,
              correlationId: e.correlationId,
              createdAt: e.createdAt,
              ...(searchParams.has('full')
                ? { eventData: (e as { eventData?: unknown }).eventData }
                : {}),
            }))
          );
        }
        if (request.method === 'GET' && parts[2] === 'stream') {
          const reader = getRun(runId).getReadable<Uint8Array>().getReader();
          const decoder = new TextDecoder();
          let text = '';
          for (;;) {
            const next = await withTimeout(reader.read(), 10_000);
            if (next === 'timeout' || next.done) break;
            text += decoder.decode(next.value, { stream: true });
          }
          return json({ text });
        }
        if (request.method === 'POST' && parts[2] === 'reset') {
          await env.WORKFLOW_RUNS.getByName(runId)
            .reset()
            .catch(() => {});
          return json({ reset: true });
        }
      }

      if (request.method === 'POST' && parts[0] === 'hooks' && parts[1]) {
        const payload = await request.json();
        const hook = await resumeHook(decodeURIComponent(parts[1]), payload);
        return json({ runId: hook.runId });
      }

      if (request.method === 'GET' && pathname === '/health') {
        return json(await healthCheck(world, { timeout: 20_000 }));
      }

      return json({ error: 'not found' }, 404);
    } catch (error) {
      const e = error as Error;
      return json({ error: e.message, name: e.name, stack: e.stack }, 500);
    }
  },
};
