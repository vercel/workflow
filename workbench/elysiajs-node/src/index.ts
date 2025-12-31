import { Elysia } from 'elysia';
import { getHookByToken, getRun, resumeHook, start } from 'workflow/api';
import { hydrateWorkflowArguments } from 'workflow/internal/serialization';
import { allWorkflows } from '../_workflows.js';
import {
  WorkflowRunFailedError,
  WorkflowRunNotCompletedError,
} from 'workflow/internal/errors';

// `idleTimeout` doesn't actually work since Nitro doesn't
// support this in their `bun` preset
const app = new Elysia({ serve: { idleTimeout: 0 } })
  .get('/', async () => {
    return 'Hello from Elysia!';
  })

  .post('/api/hook', async ({ body }) => {
    const { token, data } = JSON.parse(body as string);

    let hook: Awaited<ReturnType<typeof getHookByToken>>;
    try {
      hook = await getHookByToken(token);
      console.log('hook', hook);
    } catch (error) {
      console.log('error during getHookByToken', error);
      return new Response(JSON.stringify(null), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await resumeHook(hook.token, {
      ...data,
      // @ts-expect-error metadata is not typed
      customData: hook.metadata?.customData,
    });

    return Response.json(hook);
  })

  .post('/api/trigger', async ({ query, body }) => {
    const workflowFile =
      (query.workflowFile as string) || 'workflows/99_e2e.ts';
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

    const workflowFn = (query.workflowFn as string) || 'simple';
    if (!workflowFn) {
      return new Response('No workflow query parameter provided', {
        status: 400,
      });
    }
    const workflow = workflows[workflowFn as keyof typeof workflows];
    if (!workflow) {
      return new Response('Workflow not found', { status: 400 });
    }

    let args: any[] = [];

    // Args from query string
    const argsParam = query.args as string;
    if (argsParam) {
      args = argsParam.split(',').map((arg) => {
        const num = parseFloat(arg);
        return Number.isNaN(num) ? arg.trim() : num;
      });
    } else {
      // Args from body
      if (body && typeof body === 'string') {
        args = hydrateWorkflowArguments(JSON.parse(body), globalThis);
      } else if (body && typeof body === 'object') {
        args = hydrateWorkflowArguments(body as any, globalThis);
      } else {
        args = [42];
      }
    }
    console.log(`Starting "${workflowFn}" workflow with args: ${args}`);

    try {
      const run = await start(workflow as any, args as any);
      console.log('Run:', run);
      // Return as JSON Response - run object needs explicit serialization
      return Response.json(run);
    } catch (err) {
      console.error(`Failed to start!!`, err);
      throw err;
    }
  })

  .get('/api/trigger', async ({ query }) => {
    const runId = query.runId as string | undefined;
    if (!runId) {
      return new Response('No runId provided', { status: 400 });
    }

    const outputStreamParam = query['output-stream'] as string | undefined;
    if (outputStreamParam) {
      const namespace =
        outputStreamParam === '1' ? undefined : outputStreamParam;
      const run = getRun(runId);
      const stream = run.getReadable({
        namespace,
      });

      const reader = stream.getReader();
      const readable = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          const data =
            value instanceof Uint8Array
              ? { data: Buffer.from(value).toString('base64') }
              : value;
          controller.enqueue(`${JSON.stringify(data)}\n`);
        },
      });

      return new Response(readable, {
        headers: { 'Content-Type': 'application/octet-stream' },
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

      const headers = new Headers({
        'X-Workflow-Run-Created-At': createdAt?.toISOString() || '',
        'X-Workflow-Run-Started-At': startedAt?.toISOString() || '',
        'X-Workflow-Run-Completed-At': completedAt?.toISOString() || '',
      });

      if (returnValue instanceof ReadableStream) {
        headers.set('Content-Type', 'application/octet-stream');

        // Read from the stream and pipe to response
        const reader = returnValue.getReader();
        const readable = new ReadableStream({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(value);
          },
        });

        return new Response(readable, { headers });
      }

      headers.set('Content-Type', 'application/json');
      return new Response(JSON.stringify(returnValue), { headers });
    } catch (error) {
      if (error instanceof Error) {
        if (WorkflowRunNotCompletedError.is(error)) {
          return new Response(
            JSON.stringify({
              ...error,
              name: error.name,
              message: error.message,
            }),
            { status: 202, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (WorkflowRunFailedError.is(error)) {
          const cause = error.cause as any;
          return new Response(
            JSON.stringify({
              ...error,
              name: error.name,
              message: error.message,
              cause: {
                message: cause.message,
                stack: cause.stack,
                code: cause.code,
              },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      console.error(
        'Unexpected error while getting workflow return value:',
        error
      );
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  })

  .post('/api/test-direct-step-call', async ({ body }) => {
    const { add } = await import('../workflows/99_e2e.js');
    const { x, y } = body as { x: number; y: number };

    console.log(`Calling step function directly with x=${x}, y=${y}`);

    const result = await add(x, y);
    console.log(`add(${x}, ${y}) = ${result}`);

    return Response.json({ result });
  });

export default app;
