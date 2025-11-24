import type { ServerInit } from '@sveltejs/kit';

export const init: ServerInit = async () => {
  // Start the Postgres World
  // Needed since we test this in CI
  if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
    import('workflow/runtime').then(async ({ getWorld }) => {
      console.log('Starting Postgres World...');
      await getWorld().start?.();
    });
  }
};
