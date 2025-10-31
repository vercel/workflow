import { getHookByToken, getRun, resumeHook, start } from 'workflow/api';
import { hydrateWorkflowArguments } from 'workflow/internal/serialization';
import { allWorkflows } from './_workflows.js';

const flow = await import('./.workflows/workflows.js');
const step = await import('./.workflows/steps.js');
const webhook = await import('./.workflows/webhook.js');

const server = Bun.serve({
  port: 3000,
  async fetch(req: Request) {
    const url = new URL(req.url);

    // Workflow DevKit protocol endpoints
    if (
      url.pathname === '/.well-known/workflow/v1/flow' &&
      req.method === 'POST'
    ) {
      return flow.POST(req);
    }

    if (
      url.pathname === '/.well-known/workflow/v1/step' &&
      req.method === 'POST'
    ) {
      return step.POST(req);
    }

    if (url.pathname.startsWith('/.well-known/workflow/v1/webhook/')) {
      const handler = webhook[req.method as keyof typeof webhook];
      if (handler && typeof handler === 'function') {
        return handler(req);
      }
    }

    // Trigger endpoint - start a workflow
    if (url.pathname === '/api/trigger' && req.method === 'POST') {
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
    }

    // Trigger endpoint - get workflow status
    if (url.pathname === '/api/trigger' && req.method === 'GET') {
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
    }

    // Hook endpoint
    if (url.pathname === '/api/hook' && req.method === 'POST') {
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
    }

    // Home page
    if (url.pathname === '/') {
      return new Response(await Bun.file('./index.html').text(), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
});

console.log(`Listening on ${server.url}`);
