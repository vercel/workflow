#!/usr/bin/env node

// Start the Postgres World before starting the Astro server
// Needed since we test this in CI
// Astro doesn't have a hook for starting the Postgres World in production
import { createWorld as createPostgresWorld } from '@workflow/world-postgres';
import { setWorld } from 'workflow/runtime';

async function main() {
  if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
    console.log('Starting Postgres World...');
    const world = await createPostgresWorld();
    setWorld(world);
    if (world.start) {
      console.log('Starting World workers...');
      await world.start();
    }
  }

  // Now start the Astro server
  await import('../dist/server/entry.mjs');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
