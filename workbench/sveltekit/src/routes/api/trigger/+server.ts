import { json, type RequestHandler } from '@sveltejs/kit';
import { getRun, start } from 'workflow/api';
import { hydrateWorkflowArguments } from 'workflow/internal/serialization';
import * as calcWorkflow from '../../../../workflows/0_calc';
import * as batchingWorkflow from '../../../../workflows/6_batching';
import * as duplicateE2e from '../../../../workflows/98_duplicate_case';
import * as e2eWorkflows from '../../../../workflows/99_e2e';

const WORKFLOW_MODULES = {
  'workflows/0_calc.ts': calcWorkflow,
  'workflows/6_batching.ts': batchingWorkflow,
  'workflows/98_duplicate_case.ts': duplicateE2e,
  'workflows/99_e2e.ts': e2eWorkflows,
} as const;

export const POST: RequestHandler = async ({ request }) => {
  const url = new URL(request.url);
  const workflowFile =
    url.searchParams.get('workflowFile') || 'workflows/99_e2e.ts';
  const workflowFn = url.searchParams.get('workflowFn') || 'simple';

  console.log('calling workflow', { workflowFile, workflowFn });

  const workflows =
    WORKFLOW_MODULES[workflowFile as keyof typeof WORKFLOW_MODULES];
  if (!workflows) {
    return json(
      { error: `Workflow file "${workflowFile}" not found` },
      { status: 404 }
    );
  }

  const workflow = workflows[workflowFn as keyof typeof workflows];
  if (!workflow) {
    return json(
      {
        error: `Workflow "${workflowFn}" not found in "${workflowFile}"`,
      },
      { status: 404 }
    );
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
    const body = await request.text();
    if (body) {
      args = hydrateWorkflowArguments(JSON.parse(body), globalThis);
    } else {
      args = [42];
    }
  }
  console.log(
    `Starting "${workflowFile}/${workflowFn}" workflow with args: ${args}`
  );

  try {
    const run = await start(workflow as any, args);
    console.log('Run:', run);
    return json(run);
  } catch (err) {
    console.error(`Failed to start!!`, err);
    throw err;
  }
};

export const GET: RequestHandler = async ({ request }) => {
  const url = new URL(request.url);
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
    return returnValue instanceof ReadableStream
      ? new Response(returnValue, {
          headers: {
            'Content-Type': 'application/octet-stream',
          },
        })
      : json(returnValue);
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'WorkflowRunNotCompletedError') {
        return json(
          {
            ...error,
            name: error.name,
            message: error.message,
          },
          { status: 202 }
        );
      }

      if (error.name === 'WorkflowRunFailedError') {
        return json(
          {
            ...error,
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
          { status: 400 }
        );
      }
    }

    console.error(
      'Unexpected error while getting workflow return value:',
      error
    );
    return json(
      {
        error: 'Internal server error',
      },
      { status: 500 }
    );
  }
};
