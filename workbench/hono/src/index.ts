import { Hono } from 'hono';
import { getHookByToken, getRun, resumeHook, start } from 'workflow/api';
import {
  WorkflowRunFailedError,
  WorkflowRunNotCompletedError,
} from 'workflow/internal/errors';
import { hydrateWorkflowArguments } from 'workflow/internal/serialization';
import { getWorld, healthCheck } from 'workflow/runtime';
import { allWorkflows } from '../_workflows.js';

const app = new Hono();

app.post('/api/trigger', async ({ req }) => {
  const url = new URL(req.url);

  const workflowFile =
    url.searchParams.get('workflowFile') || 'workflows/99_e2e.ts';
  if (!workflowFile) {
    return new Response('No workflowFile query parameter provided', {
      status: 400,
    });
  }
  const workflows = allWorkflows[workflowFile as keyof typeof allWorkflows];
  if (!workflows) {
    return new Response(`Workflow file "${workflowFile}" not found`, {
      status: 400,
    });
  }

  const workflowFn = url.searchParams.get('workflowFn') || 'simple';
  if (!workflowFn) {
    return new Response('No workflow query parameter provided', {
      status: 400,
    });
  }
  const workflow = workflows[workflowFn as keyof typeof workflows];
  if (!workflow) {
    return new Response(`Workflow "${workflowFn}" not found`, { status: 400 });
  }

  let args: any[] = [];

  // Args from query string
  const argsParam = url.searchParams.get('args');
  if (argsParam) {
    args = argsParam.split(',').map((arg) => {
      const num = parseFloat(arg);
      return Number.isNaN(num) ? arg.trim() : num;
    });
  } else {
    // Args from body
    const body = await req.text();
    if (body) {
      args = hydrateWorkflowArguments(JSON.parse(body), globalThis);
    } else {
      args = [42];
    }
  }
  console.log(`Starting "${workflowFn}" workflow with args: ${args}`);

  try {
    const run = await start(workflow as any, args as any);
    console.log('Run:', run);
    return Response.json(run);
  } catch (err) {
    console.error(`Failed to start!!`, err);
    throw err;
  }
});

app.get('/api/trigger', async ({ req }) => {
  const url = new URL(req.url);
  const runId = url.searchParams.get('runId');
  if (!runId) {
    return new Response('No runId provided', { status: 400 });
  }

  const outputStreamParam = url.searchParams.get('output-stream');
  if (outputStreamParam) {
    const namespace = outputStreamParam === '1' ? undefined : outputStreamParam;
    const run = getRun(runId);
    const stream = run.getReadable({
      namespace,
    });
    // Add JSON framing to the stream, wrapping binary data in base64
    const streamWithFraming = new TransformStream({
      transform(chunk, controller) {
        const data =
          chunk instanceof Uint8Array
            ? { data: Buffer.from(chunk).toString('base64') }
            : chunk;
        controller.enqueue(`${JSON.stringify(data)}\n`);
      },
    });
    return new Response(stream.pipeThrough(streamWithFraming), {
      headers: {
        'Content-Type': 'application/octet-stream',
      },
    });
  }

  try {
    const run = getRun(runId);
    const returnValue = await run.returnValue;
    console.log('Return value:', returnValue);

    // Include run metadata in headers
    const [createdAt, startedAt, completedAt] = await Promise.all([
      run.createdAt,
      run.startedAt,
      run.completedAt,
    ]);
    const headers: HeadersInit =
      returnValue instanceof ReadableStream
        ? { 'Content-Type': 'application/octet-stream' }
        : {};

    headers['X-Workflow-Run-Created-At'] = createdAt?.toISOString() || '';
    headers['X-Workflow-Run-Started-At'] = startedAt?.toISOString() || '';
    headers['X-Workflow-Run-Completed-At'] = completedAt?.toISOString() || '';

    return returnValue instanceof ReadableStream
      ? new Response(returnValue, { headers })
      : Response.json(returnValue, { headers });
  } catch (error) {
    if (error instanceof Error) {
      if (WorkflowRunNotCompletedError.is(error)) {
        return Response.json(
          {
            ...error,
            name: error.name,
            message: error.message,
          },
          { status: 202 }
        );
      }

      if (WorkflowRunFailedError.is(error)) {
        const cause = error.cause;
        return Response.json(
          {
            ...error,
            name: error.name,
            message: error.message,
            cause: {
              message: cause.message,
              stack: cause.stack,
              code: cause.code,
            },
          },
          { status: 400 }
        );
      }
    }

    console.error(
      'Unexpected error while getting workflow return value:',
      error
    );
    return Response.json(
      {
        error: 'Internal server error',
      },
      { status: 500 }
    );
  }
});

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
