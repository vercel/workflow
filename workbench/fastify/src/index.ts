import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify from 'fastify';
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
