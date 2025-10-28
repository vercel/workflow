import { serve } from '@hono/node-server';
import { createWorkflowRoutes } from '@workflow/hono';
import { Hono } from 'hono';
import { start } from 'workflow/api';
import { simple } from '../workflows/1_simple.js';

const app = new Hono();

const workflowRoutes = await createWorkflowRoutes();

app.route('/.well-known/workflow', workflowRoutes as any);

app.get('/', async (c) => {
  const run = await start(simple, [1]);
  return c.json(run.runId);
});

serve(
  {
    fetch: app.fetch,
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  }
);
