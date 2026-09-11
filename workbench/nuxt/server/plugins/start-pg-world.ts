import { defineNitroPlugin } from '#imports';

// Start the Postgres World
// Needed since we test this in CI
export default defineNitroPlugin(async () => {
  if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
    const { initializeWorkflow } = await import('#workflow/workflows.mjs');
    await initializeWorkflow();
    const { getWorld } = await import('workflow/runtime');
    console.log('Starting World workers...');
    await (await getWorld()).start?.();
  }
});
