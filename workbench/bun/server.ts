import { getHookByToken, getRun, resumeHook, start } from 'workflow/api';
import { hydrateWorkflowArguments } from 'workflow/internal/serialization';
import * as step from './.workflows/steps.js';
import * as webhook from './.workflows/webhook.js';
import * as flow from './.workflows/workflows.js';
import { allWorkflows } from './_workflows.js';

const server = Bun.serve({
  port: 3000,
  // `routes` requires Bun v1.2.3+
  routes: {
    // Workflow DevKit protocol endpoints
    '/.well-known/workflow/v1/flow': {
      POST: (req) => flow.POST(req),
    },
    '/.well-known/workflow/v1/step': {
      POST: (req) => step.POST(req),
    },
    '/.well-known/workflow/v1/webhook/:token': webhook,

    // Custom endpoints for triggering workflows and handling webhooks
    '/api/hook': {
      POST: async (req) => {
        const body = (await req.json()) as { token: string; data: any };

        let hook: Awaited<ReturnType<typeof getHookByToken>>;
        try {
          hook = await getHookByToken(body.token);
          console.log('hook', hook);
        } catch (error) {
          console.log('error during getHookByToken', error);
          return Response.json(null, { status: 404 });
        }

        await resumeHook(hook.token, {
          ...body.data,
          // @ts-expect-error metadata is not typed
          customData: hook.metadata?.customData,
        });

        return Response.json(hook);
      },
    },
    '/api/trigger': {
      POST: async (req) => {
        const url = new URL(req.url);
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

        const argsParam = url.searchParams.get('args');
        if (argsParam) {
          args = argsParam.split(',').map((arg) => {
            const num = parseFloat(arg);
            return Number.isNaN(num) ? arg.trim() : num;
          });
        } else {
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
      },
      GET: async (req) => {
        const url = new URL(req.url);
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
            : Response.json(returnValue);
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
    },
    '/': {
      GET: async (_) => {
        return new Response(await Bun.file('./index.html').text(), {
          headers: { 'Content-Type': 'text/html' },
        });
      },
    },
  },
  async fetch(_) {
    return new Response('Not Found', { status: 404 });
  },
});

console.log(`Listening on ${server.url}`);
