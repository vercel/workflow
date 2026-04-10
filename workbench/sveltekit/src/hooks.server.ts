import type { ServerInit } from '@sveltejs/kit';

export const init: ServerInit = async () => {
  // Start the Postgres World
  // Needed since we test this in CI
  if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
    const { getWorld } = await import('workflow/runtime');
    const world = await getWorld();
    if (world.start) {
      console.log('Starting World workers...');
      await world.start();
    }
  }
};
