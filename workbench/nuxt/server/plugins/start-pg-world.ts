import { createWorld as createPostgresWorld } from '@workflow/world-postgres';
import { setWorld } from 'workflow/runtime';
import { defineNitroPlugin } from '#imports';

// Start the Postgres World
// Needed since we test this in CI
export default defineNitroPlugin(async () => {
  if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
    const world = await createPostgresWorld();
    setWorld(world);
    if (world.start) {
      console.log('Starting World workers...');
      await world.start();
    }
  }
});
