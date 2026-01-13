import express from 'express';
import { getHookByToken, getRun, resumeHook, start } from 'workflow/api';
import {
  WorkflowRunFailedError,
  WorkflowRunNotCompletedError,
} from 'workflow/internal/errors';
import { hydrateWorkflowArguments } from 'workflow/internal/serialization';
import { getWorld, healthCheck } from 'workflow/runtime';
import { allWorkflows } from '../_workflows.js';

const app = express();

app.use(express.json());
app.use(express.text({ type: 'text/*' }));

app.post('/api/hook', async (req, res) => {
  const { token, data } = JSON.parse(req.body);

  let hook: Awaited<ReturnType<typeof getHookByToken>>;
  try {
    hook = await getHookByToken(token);
    console.log('hook', hook);
  } catch (error) {
    console.log('error during getHookByToken', error);
    // TODO: `WorkflowAPIError` is not exported, so for now
    // we'll return 422 assuming it's the "invalid" token test case
    // NOTE: Need to return 422 because Nitro passes 404 requests to the dev server to handle.
    return res.status(422).json(null);
  }

  await resumeHook(hook.token, {
    ...data,
    // @ts-expect-error metadata is not typed
    customData: hook.metadata?.customData,
  });

  return res.json(hook);
});

app.post('/api/trigger', async (req, res) => {
  const workflowFile =
    (req.query.workflowFile as string) || 'workflows/99_e2e.ts';
  if (!workflowFile) {
    return res.status(400).send('No workflowFile query parameter provided');
  }
  const workflows = allWorkflows[workflowFile as keyof typeof allWorkflows];
  if (!workflows) {
    return res.status(400).send(`Workflow file "${workflowFile}" not found`);
  }

  const workflowFn = (req.query.workflowFn as string) || 'simple';
  if (!workflowFn) {
    return res.status(400).send('No workflow query parameter provided');
  }
  const workflow = workflows[workflowFn as keyof typeof workflows];
  if (!workflow) {
    return res.status(400).send('Workflow not found');
  }

  let args: any[] = [];

  // Args from query string
  const argsParam = req.query.args as string;
  if (argsParam) {
    args = argsParam.split(',').map((arg) => {
      const num = parseFloat(arg);
      return Number.isNaN(num) ? arg.trim() : num;
    });
  } else {
    // Args from body
    const body = req.body;
    if (body && typeof body === 'string') {
      args = hydrateWorkflowArguments(JSON.parse(body), globalThis);
    } else if (body && typeof body === 'object') {
      args = hydrateWorkflowArguments(body, globalThis);
    } else {
      args = [42];
    }
  }
  console.log(`Starting "${workflowFn}" workflow with args: ${args}`);

  try {
    const run = await start(workflow as any, args as any);
    console.log('Run:', run);
    return res.json(run);
  } catch (err) {
    console.error(`Failed to start!!`, err);
    throw err;
  }
});

app.get('/api/trigger', async (req, res) => {
  const runId = req.query.runId as string | undefined;
  if (!runId) {
    return res.status(400).send('No runId provided');
  }

  const outputStreamParam = req.query['output-stream'] as string | undefined;
  if (outputStreamParam) {
    const namespace = outputStreamParam === '1' ? undefined : outputStreamParam;
    const run = getRun(runId);
    const stream = run.getReadable({
      namespace,
    });

    // Set headers
    res.setHeader('Content-Type', 'application/octet-stream');

    // Read from the stream and write to Express response
    const reader = stream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Add JSON framing to each chunk, wrapping binary data in base64
        const data =
          value instanceof Uint8Array
            ? { data: Buffer.from(value).toString('base64') }
            : value;
        res.write(`${JSON.stringify(data)}\n`);
      }
      res.end();
    } catch (error) {
      console.error('Error streaming data:', error);
      res.end();
    }
    return;
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
    res.setHeader('X-Workflow-Run-Created-At', createdAt?.toISOString() || '');
    res.setHeader('X-Workflow-Run-Started-At', startedAt?.toISOString() || '');
    res.setHeader(
      'X-Workflow-Run-Completed-At',
      completedAt?.toISOString() || ''
    );

    if (returnValue instanceof ReadableStream) {
      // Set headers for streaming response
      res.setHeader('Content-Type', 'application/octet-stream');

      // Read from the stream and write to Express response
      const reader = returnValue.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      } catch (streamError) {
        console.error('Error streaming return value:', streamError);
        res.end();
      }
      return;
    }

    return res.json(returnValue);
  } catch (error) {
    if (error instanceof Error) {
      if (WorkflowRunNotCompletedError.is(error)) {
        return res.status(202).json({
          ...error,
          name: error.name,
          message: error.message,
        });
      }

      if (WorkflowRunFailedError.is(error)) {
        const cause = error.cause;
        return res.status(400).json({
          ...error,
          name: error.name,
          message: error.message,
          cause: {
            message: cause.message,
            stack: cause.stack,
            code: cause.code,
          },
        });
      }
    }

    console.error(
      'Unexpected error while getting workflow return value:',
      error
    );
    return res.status(500).json({
      error: 'Internal server error',
    });
  }
});

app.post('/api/test-health-check', async (req, res) => {
  // This route tests the queue-based health check functionality
  try {
    const { endpoint = 'workflow', timeout = 30000 } = req.body;

    console.log(
      `Testing queue-based health check for endpoint: ${endpoint}, timeout: ${timeout}ms`
    );

    const world = getWorld();
    const result = await healthCheck(world, endpoint, { timeout });

    console.log(`Health check result:`, result);

    return res.json(result);
  } catch (error) {
    console.error('Health check test failed:', error);
    return res.status(500).json({
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/api/test-direct-step-call', async (req, res) => {
  // This route tests calling step functions directly outside of any workflow context
  // After the SWC compiler changes, step functions in client mode have their directive removed
  // and keep their original implementation, allowing them to be called as regular async functions
  // Import from 98_duplicate_case.ts to avoid path alias imports
  const { add } = await import('../workflows/98_duplicate_case.js');

  const { x, y } = req.body;

  console.log(`Calling step function directly with x=${x}, y=${y}`);

  // Call step function directly as a regular async function (no workflow context)
  const result = await add(x, y);
  console.log(`add(${x}, ${y}) = ${result}`);

  return res.json({ result });
});

export default app;
