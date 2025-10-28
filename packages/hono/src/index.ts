import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkflowConfig } from '@workflow/cli/dist/lib/config/types';
import { Hono } from 'hono';
import { LocalBuilder } from './builder';

async function loadBundle(outdir: string, filename: string) {
  const path = join(process.cwd(), outdir, filename);
  const module = await import(pathToFileURL(path).href);
  const handler = module.POST;
  return { handler };
}

export async function createWorkflowRoutes(
  options?: Partial<WorkflowConfig>
): Promise<Hono> {
  options ??= {};
  const app = new Hono();
  const outDir = '.workflow';

  const isVercelDeploy = process.env.VERCEL === '1';

  if (isVercelDeploy) {
    // TODO: Implement Vercel builder
  } else {
    await new LocalBuilder(options).build();

    // Load bundles
    const stepsModule = await loadBundle(outDir, 'steps.mjs');
    const workflowsModule = await loadBundle(outDir, 'workflows.mjs');
    const webhookModule = await loadBundle(outDir, 'webhook.mjs');

    // Register routes directly on one app
    app.post('/v1/step', async (c) => {
      return await stepsModule.handler(c.req.raw);
    });

    app.post('/v1/flow', async (c) => {
      return await workflowsModule.handler(c.req.raw);
    });

    app.all('/v1/webhook/:token', async (c) => {
      const handler = webhookModule.handler;
      if (!handler) return c.text('Method not supported', 405);
      return await handler(c.req.raw);
    });
  }

  return app;
}
