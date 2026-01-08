// This route tests the queue-based health check functionality

import { getWorld, healthCheck } from 'workflow/runtime';

export default async (event: { req: Request }) => {
  try {
    const body = await event.req.json();
    const { endpoint = 'workflow', timeout = 30000 } = body;

    console.log(
      `Testing queue-based health check for endpoint: ${endpoint}, timeout: ${timeout}ms`
    );

    const world = getWorld();
    const result = await healthCheck(world, endpoint, { timeout });

    console.log(`Health check result:`, result);

    return result;
  } catch (error) {
    console.error('Health check test failed:', error);
    return {
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
