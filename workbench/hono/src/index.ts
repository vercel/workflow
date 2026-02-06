import { Hono } from 'hono';
import { getHookByToken, resumeHook } from 'workflow/api';
import { getWorld, healthCheck } from 'workflow/runtime';
// Side-effect import to keep _workflows in Nitro's dependency graph for HMR
import '../_workflows.js';

const app = new Hono();

app.post('/api/hook', async ({ req }) => {
  const { token, data } = await req.json();

  let hook: Awaited<ReturnType<typeof getHookByToken>>;
  try {
    hook = await getHookByToken(token);
    console.log('hook', hook);
  } catch (error) {
    console.log('error during getHookByToken', error);
    // TODO: `WorkflowAPIError` is not exported, so for now
    // we'll return 422 assuming it's the "invalid" token test case
    // NOTE: Need to return 422 because Nitro passes 404 requests to the dev server to handle.
    return Response.json(null, { status: 422 });
  }

  await resumeHook(hook.token, {
    ...data,
    // @ts-expect-error metadata is not typed
    customData: hook.metadata?.customData,
  });

  return Response.json(hook);
});

app.post('/api/test-health-check', async ({ req }) => {
  // This route tests the queue-based health check functionality
  try {
    const body = await req.json();
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
});

app.post('/api/test-direct-step-call', async ({ req }) => {
  // This route tests calling step functions directly outside of any workflow context
  // After the SWC compiler changes, step functions in client mode have their directive removed
  // and keep their original implementation, allowing them to be called as regular async functions
  // Import from 98_duplicate_case.ts to avoid path alias imports
  const { add } = await import('../workflows/98_duplicate_case.js');

  const body = await req.json();
  const { x, y } = body;

  console.log(`Calling step function directly with x=${x}, y=${y}`);

  // Call step function directly as a regular async function (no workflow context)
  const result = await add(x, y);
  console.log(`add(${x}, ${y}) = ${result}`);

  return Response.json({ result });
});

export default app;
