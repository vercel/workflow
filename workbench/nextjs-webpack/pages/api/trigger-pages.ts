import type { NextApiRequest, NextApiResponse } from 'next';
import { getRun, start } from 'workflow/api';
import {
  WorkflowRunFailedError,
  WorkflowRunNotCompletedError,
} from 'workflow/internal/errors';
import { hydrateWorkflowArguments } from 'workflow/internal/serialization';
import { allWorkflows } from '@/_workflows';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'POST') {
    return handlePost(req, res);
  } else if (req.method === 'GET') {
    return handleGet(req, res);
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
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

  // Handle static method lookups (e.g., "Calculator.calculate")
  let workflow: unknown;
  if (workflowFn.includes('.')) {
    const [className, methodName] = workflowFn.split('.');
    const cls = workflows[className as keyof typeof workflows];
    if (cls && typeof cls === 'function') {
      workflow = (cls as Record<string, unknown>)[methodName];
    }
  } else {
    workflow = workflows[workflowFn as keyof typeof workflows];
  }
  if (!workflow) {
    return res.status(400).send(`Workflow "${workflowFn}" not found`);
  }

  let args: any[] = [];

  // Args from query string
  const argsParam = req.query.args as string | undefined;
  if (argsParam) {
    args = argsParam.split(',').map((arg) => {
      const num = parseFloat(arg);
      return Number.isNaN(num) ? arg.trim() : num;
    });
  } else {
    // Args from body
    args = hydrateWorkflowArguments(JSON.parse(req.body), globalThis);
  }
  console.log(`Starting "${workflowFn}" workflow with args: ${args}`);

  try {
    const run = await start(workflow as any, args as any);
    console.log('Run', run.runId);
    return res.status(200).json(run);
  } catch (err) {
    console.error(`Failed to start!!`, err);
    throw err;
  }
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
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

    res.setHeader('Content-Type', 'application/octet-stream');

    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const data =
          value instanceof Uint8Array
            ? { data: Buffer.from(value).toString('base64') }
            : value;
        res.write(`${JSON.stringify(data)}\n`);
      }
    } finally {
      reader.releaseLock();
    }
    return res.end();
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
      res.setHeader('Content-Type', 'application/octet-stream');
      const reader = returnValue.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } finally {
        reader.releaseLock();
      }
      return res.end();
    }

    return res.status(200).json(returnValue);
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
}
