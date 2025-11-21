import Fastify from 'fastify';
import { fromNodeHandler } from 'nitro/h3';
import { getHookByToken, getRun, resumeHook, start } from 'workflow/api';
import { hydrateWorkflowArguments } from 'workflow/internal/serialization';
import {
  WorkflowRunFailedError,
  WorkflowRunNotCompletedError,
} from 'workflow/internal/errors';
import { allWorkflows } from '../_workflows.js';

const server = Fastify({
  logger: true,
});

console.log('Fastify Server created!');

// Add content type parser for text/*
server.addContentTypeParser(
  'text/*',
  { parseAs: 'string' },
  server.getDefaultJsonParser('ignore', 'ignore')
);

server.post('/api/hook', async (req: any, reply) => {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { token, data } = body;

  let hook: Awaited<ReturnType<typeof getHookByToken>>;
  try {
    hook = await getHookByToken(token);
    console.log('hook', hook);
  } catch (error) {
    console.log('error during getHookByToken', error);
    return reply.code(422).send(null);
  }

  await resumeHook(hook.token, {
    ...data,
    // @ts-expect-error metadata is not typed
    customData: hook.metadata?.customData,
  });

  return hook;
});

server.post('/api/trigger', async (req: any, reply) => {
  const workflowFile =
    (req.query.workflowFile as string) || 'workflows/99_e2e.ts';
  if (!workflowFile) {
    return reply.code(400).send('No workflowFile query parameter provided');
  }
  const workflows = allWorkflows[workflowFile as keyof typeof allWorkflows];
  if (!workflows) {
    return reply.code(400).send(`Workflow file "${workflowFile}" not found`);
  }

  const workflowFn = (req.query.workflowFn as string) || 'simple';
  if (!workflowFn) {
    return reply.code(400).send('No workflow query parameter provided');
  }
  const workflow = workflows[workflowFn as keyof typeof workflows];
  if (!workflow) {
    return reply.code(400).send('Workflow not found');
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
    return run;
  } catch (err) {
    console.error(`Failed to start!!`, err);
    throw err;
  }
});

server.get('/api/trigger', async (req: any, reply) => {
  const runId = req.query.runId as string | undefined;
  if (!runId) {
    return reply.code(400).send('No runId provided');
  }

  const outputStreamParam = req.query['output-stream'] as string | undefined;
  if (outputStreamParam) {
    const namespace = outputStreamParam === '1' ? undefined : outputStreamParam;
    const run = getRun(runId);
    const stream = run.getReadable({
      namespace,
    });

    // Set headers
    reply.header('Content-Type', 'application/octet-stream');

    // Read from the stream and write to response
    const reader = stream.getReader();

    return (async function* () {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Add JSON framing to each chunk, wrapping binary data in base64
          const data =
            value instanceof Uint8Array
              ? { data: Buffer.from(value).toString('base64') }
              : value;
          yield `${JSON.stringify(data)}\n`;
        }
      } catch (error) {
        console.error('Error streaming data:', error);
      }
    })();
  }

  try {
    const run = getRun(runId);
    const returnValue = await run.returnValue;
    console.log('Return value:', returnValue);

    if (returnValue instanceof ReadableStream) {
      // Set headers for streaming response
      reply.header('Content-Type', 'application/octet-stream');

      // Read from the stream and write to response
      const reader = returnValue.getReader();

      return (async function* () {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            yield value;
          }
        } catch (streamError) {
          console.error('Error streaming return value:', streamError);
        }
      })();
    }

    return returnValue;
  } catch (error) {
    if (error instanceof Error) {
      if (WorkflowRunNotCompletedError.is(error)) {
        return reply.code(202).send({
          ...error,
          name: error.name,
          message: error.message,
        });
      }

      if (WorkflowRunFailedError.is(error)) {
        const cause = error.cause;
        return reply.code(400).send({
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
    return reply.code(500).send({
      error: 'Internal server error',
    });
  }
});

server.post('/api/test-direct-step-call', async (req: any, reply) => {
  // This route tests calling step functions directly outside of any workflow context
  // After the SWC compiler changes, step functions in client mode have their directive removed
  // and keep their original implementation, allowing them to be called as regular async functions
  const { add } = await import('../workflows/99_e2e.js');

  const { x, y } = req.body;

  console.log(`Calling step function directly with x=${x}, y=${y}`);

  // Call step function directly as a regular async function (no workflow context)
  const result = await add(x, y);
  console.log(`add(${x}, ${y}) = ${result}`);

  return { result };
});

await server.ready();

export default fromNodeHandler((req, res) => {
  return new Promise((resolve) => {
    res.on('finish', resolve);
    server.server.emit('request', req, res);
  });
});
