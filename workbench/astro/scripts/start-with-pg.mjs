#!/usr/bin/env node

// Start the Postgres World before starting the Astro server
// Needed since we test this in CI
// Astro doesn't have a hook for starting the Postgres World in production

async function main() {
  if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
    // The worker entry the Workflow integration emits with the server build:
    // hands the flow route to the World and starts it, so this process runs
    // the jobs in process.
    console.log('Starting the Workflow worker...');
    const { startWorkflowWorker } = await import(
      '../dist/server/workflow-worker.mjs'
    );
    await startWorkflowWorker();
  }

  // Now start the Astro server
  await import('../dist/server/entry.mjs');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
