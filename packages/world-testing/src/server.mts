import fs from 'node:fs';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { getHookByToken, getRun, resumeHook, start } from 'workflow/api';
import { getWorld } from 'workflow/runtime';
import * as z from 'zod';
import flow from '../.well-known/workflow/v1/flow.js';
import manifest from '../.well-known/workflow/v1/manifest.json' with {
  type: 'json',
};
import step from '../.well-known/workflow/v1/step.js';

if (!process.env.WORKFLOW_TARGET_WORLD) {
  console.error(
    'Error: WORKFLOW_TARGET_WORLD environment variable is not set.'
  );
  process.exit(1);
}

type WorkflowIds = keyof typeof manifest.workflows;
type NonEmptyArray<T> = [T, ...T[]];

const Invoke = z
  .object({
    workflowId: z.enum(
      Object.keys(manifest.workflows) as NonEmptyArray<WorkflowIds>
    ),
    args: z.unknown().array().default([]),
  })
  .transform((obj) => {
    const workflowId = obj.workflowId as WorkflowIds;
    return {
      args: obj.args,
      workflow: manifest.workflows[workflowId],
    };
  });

const app = new Hono()
  .post('/.well-known/workflow/v1/flow', (ctx) => {
    return flow.POST(ctx.req.raw);
  })
  .post('/.well-known/workflow/v1/step', (ctx) => {
    return step.POST(ctx.req.raw);
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
    const run = await getWorld().runs.get(ctx.req.param('runId'));
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

    for (const workflowId of Object.keys(manifest.workflows)) {
      console.log(
        `$ curl -X POST http://localhost:${info.port}/invoke -d '${JSON.stringify(
          { workflowId }
        )}'`
      );
    }

    const world = getWorld();
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
