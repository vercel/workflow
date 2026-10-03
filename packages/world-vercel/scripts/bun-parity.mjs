// Runs the built package under Bun and checks that world-vercel's requests get
// the transport behavior they get on Node: retries from the RetryAgent and
// deadlines from the agent options (see src/undici-runtime.ts). vitest runs on
// Node, so nothing else exercises this. Local servers only, no network.
//
//   pnpm --filter @workflow/world-vercel build
//   bun packages/world-vercel/scripts/bun-parity.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
// Bun resolves this bare specifier to its built-in module: a stub `Agent`.
import { Agent as BareSpecifierAgent } from 'undici';
import {
  createEventsDispatcher,
  createQueueDispatcher,
  getDispatcher,
} from '../dist/http-client.js';
import { instrumentedFetch } from '../dist/http-core.js';
import { MIN_BUN_VERSION, undiciRuntime } from '../dist/undici-runtime.js';

const bunVersion = process.versions.bun;
assert.ok(bunVersion, 'run this script with bun');

const [major, minor] = bunVersion.split('.').map(Number);
const [minMajor, minMinor] = MIN_BUN_VERSION;
const supported = major > minMajor || (major === minMajor && minor >= minMinor);
const routed = undiciRuntime.fetch !== undefined;
console.log(`bun ${bunVersion}: routed through undici = ${routed}`);
assert.equal(
  routed,
  supported,
  `expected routing ${supported ? 'on' : 'off'} for MIN_BUN_VERSION ${MIN_BUN_VERSION.join('.')}`
);

const listen = async (handler) => {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
};
const get = (url, dispatcher) =>
  instrumentedFetch({
    method: 'GET',
    url,
    headers: new Headers(),
    dispatcher,
    timeoutMs: null,
  });

// Every Bun must at least build the dispatchers and complete a request.
assert.ok(createQueueDispatcher());
const ok = await listen((_req, res) => res.end('ok'));
assert.equal((await get(ok.url, getDispatcher())).status, 200);
// A caller-supplied dispatcher built from the bare specifier cannot dispatch,
// and must keep being ignored the way Bun's global fetch ignores it.
assert.equal((await get(ok.url, new BareSpecifierAgent())).status, 200);
ok.server.close();

if (routed) {
  // RetryAgent: two 503s, then success, on one call.
  let hits = 0;
  const flaky = await listen((_req, res) => {
    hits++;
    res.statusCode = hits <= 2 ? 503 : 200;
    res.end();
  });
  assert.equal((await get(flaky.url, getDispatcher())).status, 200);
  assert.equal(hits, 3, 'the RetryAgent should have retried both 503s');
  flaky.server.close();

  // Agent options: headersTimeout fails a silent origin. The global fetch on
  // Bun would wait out its own 300s default instead.
  const headersTimeout = 1_000;
  const silent = await listen(() => {});
  const start = performance.now();
  await assert.rejects(
    get(silent.url, createEventsDispatcher({ headersTimeout })),
    (error) => error.code === 'TRANSPORT'
  );
  const elapsed = performance.now() - start;
  assert.ok(
    elapsed < headersTimeout * 5,
    `headersTimeout took ${Math.round(elapsed)}ms`
  );
  silent.server.closeAllConnections();
  silent.server.close();
}

console.log('ok');
process.exit(0);
