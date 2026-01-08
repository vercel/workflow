import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { getHookByToken, getRun, resumeHook, start } from 'workflow/api';
import {
  WorkflowRunFailedError,
  WorkflowRunNotCompletedError,
} from 'workflow/internal/errors';
import { hydrateWorkflowArguments } from 'workflow/internal/serialization';
import { getWorld, healthCheck } from 'workflow/runtime';
import { allWorkflows } from '../_workflows.js';

type JsonResult = { ok: true; value: any } | { ok: false; error: Error };
const parseJson = (text: string): JsonResult => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error as Error };
  }
};

const server = Fastify({
  logger: true,
});

server.addContentTypeParser(
  'text/*',
  { parseAs: 'string' },
  server.getDefaultJsonParser('ignore', 'ignore')
);

// allow fastify to parse empty json requests
server.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString();
    if (!text) return done(null, {});
    const parsed = parseJson(text);
    return parsed.ok ? done(null, parsed.value) : done(parsed.error);
  }
);

server.get('/', async (req, reply) => {
  const html = await readFile(resolve('./index.html'), 'utf-8');
  return reply.type('text/html').send(html);
});

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

  try {
    const run = getRun(runId);

    if (outputStreamParam) {
      const namespace =
        outputStreamParam === '1' ? undefined : outputStreamParam;
      const stream = run.getReadable({ namespace });
      const reader = stream.getReader();

      const toFramedChunk = (value: unknown) => {
        if (typeof value === 'string') {
          return { data: Buffer.from(value).toString('base64') };
        }
        if (value instanceof ArrayBuffer) {
          return { data: Buffer.from(value).toString('base64') };
        }
        if (ArrayBuffer.isView(value)) {
          const view = value as ArrayBufferView;
          const buf = Buffer.from(
            view.buffer,
            view.byteOffset,
            view.byteLength
          );
          return { data: buf.toString('base64') };
        }
        return value;
      };

      reply.type('application/octet-stream');
      // Fastify runs on Node and doesn’t send Web ReadableStreams directly
      // read from the Web reader and write framed chunks to the raw response
      try {
        let chunkCount = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          chunkCount += 1;

          const framed = toFramedChunk(value);
          reply.raw.write(`${JSON.stringify(framed)}\n`);
        }
        reply.raw.end();
      } catch (error) {
        console.error('Error streaming data:', error);
        reply.raw.end();
      } finally {
        reader.releaseLock();
      }
      return;
    }

    const returnValue = await run.returnValue;
    console.log('Return value:', returnValue);

    if (returnValue instanceof ReadableStream) {
      const reader = returnValue.getReader();
      // reply.type() doesn't apply when we write directly to reply.raw
      reply.raw.setHeader('Content-Type', 'application/octet-stream');

      // Workflow returns a Web ReadableStream; stream it by pulling from
      // its reader and writing to reply.raw so Fastify can flush it to the client
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          reply.raw.write(value);
        }
        reply.raw.end();
      } catch (streamError) {
        console.error('Error streaming return value:', streamError);
        reply.raw.end();
      } finally {
        reader.releaseLock();
      }
      return;
    }

    // Fastify sends strings as text/plain by default
    const payload =
      typeof returnValue === 'string' ||
      typeof returnValue === 'number' ||
      typeof returnValue === 'boolean'
        ? JSON.stringify(returnValue)
        : returnValue;
    return reply.type('application/json').send(payload);
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

server.post('/api/test-health-check', async (req: any, reply) => {
  // This route tests the queue-based health check functionality
  try {
    const { endpoint = 'workflow', timeout = 30000 } = req.body;

    console.log(
      `Testing queue-based health check for endpoint: ${endpoint}, timeout: ${timeout}ms`
    );

    const world = getWorld();
    const result = await healthCheck(world, endpoint, { timeout });

    console.log(`Health check result:`, result);

    return reply.send(result);
  } catch (error) {
    console.error('Health check test failed:', error);
    return reply.code(500).send({
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.post('/api/test-direct-step-call', async (req: any, reply) => {
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

  return reply.send({ result });
});

await server.ready();

export default (req: any, res: any) => {
  server.server.emit('request', req, res);
};
