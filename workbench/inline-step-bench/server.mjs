// Minimal local workflow host for the inline-step benchmark.
//
// Trimmed-down copy of packages/world-testing/src/server.mts: it mounts the
// generated flow route, counts flow-handler invocations per run (so the
// benchmark can assert the whole chain really did stay in ONE invocation), and
// exposes the run's hydrated output plus its raw event log with timestamps.

import fs from 'node:fs';
import { serve } from '@hono/node-server';
import { hydrateWorkflowReturnValue } from '@workflow/core/serialization';
import { Hono } from 'hono';
import { start } from 'workflow/api';
import { getWorld } from 'workflow/runtime';
import { POST as flowPOST } from './.well-known/workflow/v1/flow.mjs';
import manifest from './.well-known/workflow/v1/manifest.json' with {
  type: 'json',
};

if (!process.env.WORKFLOW_TARGET_WORLD) {
  console.error('Error: WORKFLOW_TARGET_WORLD is not set.');
  process.exit(1);
}

/** runId -> number of POSTs to the flow route. */
const flowInvocationCounts = new Map();

const app = new Hono()
  .post('/.well-known/workflow/v1/flow', async (ctx) => {
    // Count before awaiting, so a run that completes inside this call is never
    // observed as completed-with-zero-invocations.
    const cloned = ctx.req.raw.clone();
    try {
      const body = await cloned.json();
      const runId =
        typeof body?.runId === 'string'
          ? body.runId
          : typeof body?.payload?.runId === 'string'
            ? body.payload.runId
            : undefined;
      if (runId) {
        flowInvocationCounts.set(
          runId,
          (flowInvocationCounts.get(runId) ?? 0) + 1
        );
      }
    } catch {
      // health check / non-JSON — ignore
    }
    return flowPOST(ctx.req.raw);
  })
  .get('/_flow-invocations/:runId', (ctx) =>
    ctx.json({ count: flowInvocationCounts.get(ctx.req.param('runId')) ?? 0 })
  )
  .post('/invoke', async (ctx) => {
    const { file, workflow, args = [] } = await ctx.req.json();
    const entry = manifest.workflows[file]?.[workflow];
    if (!entry) {
      return ctx.json({ error: `unknown workflow ${file}#${workflow}` }, 400);
    }
    const startedAt = Date.now();
    const handler = await start(entry, args);
    return ctx.json({ runId: handler.runId, startedAt });
  })
  .get('/runs/:runId', async (ctx) => {
    const world = await getWorld();
    const run = await world.runs.get(ctx.req.param('runId'));
    let output;
    if (run.output) {
      output = await hydrateWorkflowReturnValue(
        run.output,
        run.runId,
        undefined
      );
    }
    return ctx.json({
      runId: run.runId,
      status: run.status,
      error: run.error ?? null,
      createdAt: run.createdAt,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
      output,
    });
  })
  .get('/runs/:runId/events', async (ctx) => {
    const runId = ctx.req.param('runId');
    const world = await getWorld();
    const events = [];
    let cursor;
    for (;;) {
      const page = await world.events.list({
        runId,
        pagination: { sortOrder: 'asc', cursor },
      });
      for (const e of page.data) {
        events.push({
          eventType: e.eventType,
          correlationId: e.correlationId,
          createdAt: +new Date(e.createdAt),
        });
      }
      if (!page.hasMore) break;
      cursor = page.cursor ?? undefined;
      if (!cursor) break;
    }
    return ctx.json({ events });
  });

serve(
  { fetch: app.fetch, port: Number(process.env.PORT) || 0 },
  async (info) => {
    process.env.PORT = String(info.port);
    const world = await getWorld();
    if (world.start) await world.start();
    if (process.env.CONTROL_FD === '3') {
      const control = fs.createWriteStream('', { fd: 3 });
      control.write(
        `${JSON.stringify({ state: 'listening', port: info.port })}\n`
      );
    }
  }
);
