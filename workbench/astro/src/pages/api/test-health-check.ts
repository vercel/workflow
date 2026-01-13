// This route tests the queue-based health check functionality

import { getWorld, healthCheck } from 'workflow/runtime';

export async function POST({ request }: { request: Request }) {
  try {
    const body = await request.json();
    const { endpoint = 'workflow', timeout = 30000 } = body;

    console.log(
      `Testing queue-based health check for endpoint: ${endpoint}, timeout: ${timeout}ms`
    );

    const world = getWorld();
    const result = await healthCheck(world, endpoint, { timeout });

    console.log(`Health check result:`, result);

    return Response.json(result);
  } catch (error) {
    console.error('Health check test failed:', error);
    return Response.json(
      {
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

export const prerender = false;
