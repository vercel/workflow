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
    return ctx.json(await getWorld().runs.get(ctx.req.param('runId')));
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
