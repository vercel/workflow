import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { getHookByToken, resumeHook } from 'workflow/api';
import { getWorld, healthCheck } from 'workflow/runtime';
// Side-effect import to keep _workflows in Nitro's dependency graph for HMR
import '../_workflows.js';

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

server.addContentTypeParser(
  'application/octet-stream',
  { parseAs: 'buffer' },
  (req, body, done) => {
    done(null, body);
  }
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
