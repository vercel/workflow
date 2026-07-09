import fs from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import {
  createWorldFromModule,
  type WorldFactoryModule,
} from '@workflow/core/runtime';
import { getWorldImport } from '@workflow/utils';
import {
  getQueuePrefixKind,
  HealthCheckPayloadSchema,
  WorkflowInvokePayloadSchema,
} from '@workflow/world';
import { Hono } from 'hono';
import { getHookByToken, getRun, resumeHook, start } from 'workflow/api';
import { getWorld, setWorld } from 'workflow/runtime';
import * as z from 'zod';
import manifest from '../.well-known/workflow/v1/manifest.json' with {
  type: 'json',
};

if (!process.env.WORKFLOW_TARGET_WORLD) {
  console.error(
    'Error: WORKFLOW_TARGET_WORLD environment variable is not set.'
  );
  process.exit(1);
}

// Track flow handler invocations per run for testing inline execution.
const flowInvocationCounts = new Map<string, number>();

function normalizeTargetWorldSpecifier(targetWorld: string): string {
  if (targetWorld.startsWith('./') || targetWorld.startsWith('../')) {
    return pathToFileURL(resolve(process.cwd(), targetWorld)).href;
  }
  return getWorldImport({ WORKFLOW_TARGET_WORLD: targetWorld });
}

async function initializeTestWorld() {
  const targetWorld = process.env.WORKFLOW_TARGET_WORLD;
  if (!targetWorld) {
    throw new Error('WORKFLOW_TARGET_WORLD environment variable is not set.');
  }

  const mod = (await import(
    normalizeTargetWorldSpecifier(targetWorld)
  )) as WorldFactoryModule;
  const world = await createWorldFromModule(mod);
  const createQueueHandler = world.createQueueHandler.bind(world);
  world.createQueueHandler = (prefix, handler) =>
    createQueueHandler(prefix, async (message, metadata) => {
      if (
        getQueuePrefixKind(prefix) === 'workflow' &&
        !HealthCheckPayloadSchema.safeParse(message).success
      ) {
        const { runId } = WorkflowInvokePayloadSchema.parse(message);
        flowInvocationCounts.set(
          runId,
          (flowInvocationCounts.get(runId) ?? 0) + 1
        );
      }
      return handler(message, metadata);
    });
  setWorld(world);
}

await initializeTestWorld();
const { POST: flowPOST } = await import('../.well-known/workflow/v1/flow.mjs');

type Files = keyof typeof manifest.workflows;
type Workflows<F extends Files> = keyof (typeof manifest.workflows)[F];
type NonEmptyArray<T> = [T, ...T[]];

const Invoke = z
  .object({
    file: z.enum(Object.keys(manifest.workflows) as NonEmptyArray<Files>),
    workflow: z.string(),
    args: z.unknown().array().default([]),
  })
  .transform((obj) => {
    const file = obj.file as keyof typeof manifest.workflows;
    const workflow = z
      .enum(
        Object.keys(manifest.workflows[file]) as NonEmptyArray<
          Workflows<typeof file>
        >
      )
      .parse(obj.workflow);
    return {
      args: obj.args,
      workflow: manifest.workflows[file][workflow],
    };
  });

const app = new Hono()
  .post('/.well-known/workflow/v1/flow', (ctx) => flowPOST(ctx.req.raw))
  .get('/_flow-invocations/:runId', (ctx) => {
    const count = flowInvocationCounts.get(ctx.req.param('runId')) ?? 0;
    return ctx.json({ count });
  })
  .get('/_manifest', (ctx) => ctx.json(manifest))
  .post('/invoke', async (ctx) => {
    const json = await ctx.req.json().then(Invoke.parse);
    const handler = await start(json.workflow, json.args);

    return ctx.json({ runId: handler.runId });
  })
  .post('/hooks/:token', async (ctx) => {
    const hook = await getHookByToken(ctx.req.param('token'));
    const { runId } = await resumeHook(hook.token, {
      ...(await ctx.req.json()),
      metadata: hook.metadata,
    });
    return ctx.json({ runId, hookId: hook.hookId });
  })
  .get('/runs/:runId', async (ctx) => {
    const world = await getWorld();
    const run = await world.runs.get(ctx.req.param('runId'));
    // Custom JSON serialization to handle Uint8Array as base64
    const json = JSON.stringify(run, (_key, value) => {
      if (value instanceof Uint8Array) {
        return {
          __type: 'Uint8Array',
          data: Buffer.from(value).toString('base64'),
        };
      }
      return value;
    });
    return new Response(json, {
      headers: { 'Content-Type': 'application/json' },
    });
  })
  .get('/runs/:runId/readable', async (ctx) => {
    const runId = ctx.req.param('runId');
    const run = getRun(runId);
    return new Response(run.getReadable());
  })
  .get('/runs/:runId/events', async (ctx) => {
    const runId = ctx.req.param('runId');
    const world = await getWorld();
    const allEvents: { eventType: string; correlationId?: string }[] = [];
    let cursor: string | undefined;
    while (true) {
      const page = await world.events.list({
        runId,
        pagination: { sortOrder: 'asc', cursor },
      });
      for (const e of page.data) {
        allEvents.push({
          eventType: e.eventType,
          correlationId: e.correlationId,
        });
      }
      if (!page.hasMore) break;
      cursor = page.cursor ?? undefined;
      if (!cursor) break;
    }
    return ctx.json({ events: allEvents });
  });

serve(
  {
    fetch: app.fetch,
    port: Number(process.env.PORT) || 0,
  },
  async (info) => {
    console.log(`👂 listening on http://${info.address}:${info.port}`);
    console.log('');

    process.env.PORT = info.port.toString();

    for (const [filename, workflows] of Object.entries(manifest.workflows)) {
      for (const workflowName of Object.keys(
        workflows as Record<string, unknown>
      )) {
        console.log(
          `$ curl -X POST http://localhost:${info.port}/invoke -d '${JSON.stringify(
            {
              file: filename,
              workflow: workflowName,
            }
          )}'`
        );
      }
    }

    const world = await getWorld();
    if (world.start) {
      console.log(`starting background tasks...`);
      await world.start().then(
        () => console.log('background tasks started.'),
        (err) => console.error('❗ error starting background tasks:', err)
      );
    }

    if (process.env.CONTROL_FD === '3') {
      const control = fs.createWriteStream('', { fd: 3 });
      control.write(`${JSON.stringify({ state: 'listening', info })}\n`);
      control.end();
    }
  }
);
