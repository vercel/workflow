import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start';
import { allWorkflows } from '_workflows.js';
import { getRun, start } from 'workflow/api';
import { hydrateWorkflowArguments } from 'workflow/internal/serialization';

export const Route = createFileRoute('/api/trigger')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);

        const runId = url.searchParams.get('runId');
        if (!runId) {
          return new Response('No runId provided', { status: 400 });
        }

        const outputStreamParam = url.searchParams.get('output-stream');
        if (outputStreamParam) {
          const namespace =
            outputStreamParam === '1' ? undefined : outputStreamParam;
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
              return Response.json(
                {
                  ...error,
                  name: error.name,
                  message: error.message,
                },
                { status: 202 }
              );
            }

            if (error.name === 'WorkflowRunFailedError') {
              return Response.json(
                {
                  ...error,
                  name: error.name,
                  message: error.message,
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
      },
      POST: async ({ request }) => {
        const url = new URL(request.url);

        const workflowFile =
          url.searchParams.get('workflowFile') || 'workflows/99_e2e.ts';
        if (!workflowFile) {
          return new Response('No workflowFile query parameter provided', {
            status: 400,
          });
        }
        const workflows =
          allWorkflows[workflowFile as keyof typeof allWorkflows];
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
          return new Response(`Workflow "${workflowFn}" not found`, {
            status: 400,
          });
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
        console.log(`Starting "${workflowFn}" workflow with args: ${args}`);

        try {
          const run = await start(workflow as any, args as any);
          console.log('Run:', run);
          return Response.json(run);
        } catch (err) {
          console.error(`Failed to start!!`, err);
          throw err;
        }
      },
    },
  },
});
