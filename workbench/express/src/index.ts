import express from 'express';
import { fromNodeHandler, type NodeMiddleware } from 'nitro/h3';
import { getHookByToken, getRun, resumeHook, start } from 'workflow/api';
import { hydrateWorkflowArguments } from 'workflow/internal/serialization';
import { allWorkflows } from '../_workflows';

const app = express();

app.use(express.json());
app.use(express.text({ type: 'text/*' }));

app.post('/api/hook', async (req, res, _) => {
  const token = req.body.token;
  const data = req.body.data;

  let hook: Awaited<ReturnType<typeof getHookByToken>>;
  try {
    hook = await getHookByToken(token);
    console.log('hook', hook);
  } catch (error) {
    console.log('error during getHookByToken', error);
    // TODO: `WorkflowAPIError` is not exported, so for now
    // we'll return 404 assuming it's the "invalid" token test case
    return res.status(404).json(null);
  }

  await resumeHook(hook.token, {
    ...data,
    // @ts-expect-error metadata is not typed
    customData: hook.metadata?.customData,
  });

  return res.json(hook);
});

app.get('/api/trigger', async (req, res, _) => {
  const runId = req.query.runId as string;
  if (!runId) {
    return res.status(400).json({
      error: 'No runId provided',
      status: 400,
    });
  }

  const outputStreamParam = req.query['output-stream'] as string;
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
    return res
      .setHeader('Content-Type', 'application/octet-stream')
      .send(stream.pipeThrough(streamWithFraming));
  }

  try {
    const run = getRun(runId);
    const returnValue = await run.returnValue;
    console.log('Return value:', returnValue);
    return returnValue instanceof ReadableStream
      ? res
          .setHeader('Content-Type', 'application/octet-stream')
          .send(returnValue)
      : res.json(returnValue);
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'WorkflowRunNotCompletedError') {
        return res.status(202).json({
          ...error,
          name: error.name,
          message: error.message,
        });
      }

      if (error.name === 'WorkflowRunFailedError') {
        return res.status(400).json({
          ...error,
          name: error.name,
          message: error.message,
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

app.post('/api/trigger', async (req, res, _) => {
  const workflowFile =
    (req.query.workflowFile as string) || 'workflows/99_e2e.ts';
  if (!workflowFile) {
    return res.status(400).json({
      error: 'No workflowFile query parameter provided',
      status: 400,
    });
  }
  const workflows = allWorkflows[workflowFile as keyof typeof allWorkflows];
  if (!workflows) {
    return res.status(400).json({
      error: `Workflow file "${workflowFile}" not found`,
      status: 400,
    });
  }

  const workflowFn = (req.query.workflowFn as string) || 'simple';
  if (!workflowFn) {
    return res.status(400).json({
      error: 'No workflow query parameter provided',
      status: 400,
    });
  }
  const workflow = workflows[workflowFn as keyof typeof workflows];
  if (!workflow) {
    return res.status(400).json({
      error: `Workflow "${workflowFn}" not found`,
      status: 400,
    });
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
    if (req.body) {
      args = hydrateWorkflowArguments(JSON.parse(req.body), globalThis);
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

export default fromNodeHandler(app as NodeMiddleware);
