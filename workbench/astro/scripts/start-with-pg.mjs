#!/usr/bin/env node

// Start the Postgres World before starting the Astro server
// Needed since we test this in CI
// Astro doesn't have a hook for starting the Postgres World in production

async function main() {
  if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
    console.log('Starting Postgres World...');
    const { getWorld } = await import('workflow/runtime');
    await getWorld().start?.();
  }

  // Now start the Astro server
  await import('../dist/server/entry.mjs');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
