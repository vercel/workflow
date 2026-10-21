import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';

// Pin the credential source before importing, so the module never reaches for
// the runner's token-mint endpoint (set when a job has `id-token: write`).
process.env.VERCEL_OIDC_TOKEN = 'test-oidc-token';
delete process.env.VERCEL_PROTECTION_BYPASS;
delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

const { fetchWithTrustedSources } = await import(
  './trusted-sources-headers.mjs'
);

const CREDENTIAL_HEADER = 'x-vercel-trusted-oidc-idp-token';

const servers = [];
after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

/** Start a loopback origin and return its base URL. */
async function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * An origin that records the credential it was handed on each request, and
 * redirects `/to/<encoded url>` at that URL.
 */
async function recordingOrigin() {
  const seen = [];
  const url = await listen((request, response) => {
    seen.push(request.headers[CREDENTIAL_HEADER]);
    request.resume();
    const match = /^\/to\/(.+)$/.exec(request.url);
    if (match) {
      response.writeHead(307, { location: decodeURIComponent(match[1]) });
      response.end();
      return;
    }
    response.end('ok');
  });
  return { url, seen };
}

test('sends the credential to the origin the caller named', async () => {
  const origin = await recordingOrigin();

  const response = await fetchWithTrustedSources(origin.url);

  assert.equal(response.status, 200);
  assert.deepEqual(origin.seen, ['test-oidc-token']);
});

test('keeps the credential on a same-origin redirect', async () => {
  const origin = await recordingOrigin();

  const response = await fetchWithTrustedSources(
    `${origin.url}/to/${encodeURIComponent('/landing')}`
  );

  assert.equal(response.status, 200);
  assert.deepEqual(origin.seen, ['test-oidc-token', 'test-oidc-token']);
});

test('drops the credential when a redirect leaves the origin', async () => {
  const elsewhere = await recordingOrigin();
  const origin = await recordingOrigin();

  const response = await fetchWithTrustedSources(
    `${origin.url}/to/${encodeURIComponent(`${elsewhere.url}/collect`)}`
  );

  // The hop is still followed, so a link check still reports the real status.
  assert.equal(response.status, 200);
  assert.deepEqual(elsewhere.seen, [undefined]);
});

test('drops the credential again after the chain returns to the origin', async () => {
  const origin = await recordingOrigin();
  const elsewhere = await listen((request, response) => {
    request.resume();
    response.writeHead(307, { location: `${origin.url}/back` });
    response.end();
  });

  const response = await fetchWithTrustedSources(
    `${origin.url}/to/${encodeURIComponent(elsewhere)}`
  );

  assert.equal(response.status, 200);
  assert.deepEqual(origin.seen, ['test-oidc-token', 'test-oidc-token']);
});

test('honours redirect: manual without following the hop', async () => {
  const elsewhere = await recordingOrigin();
  const origin = await recordingOrigin();

  const response = await fetchWithTrustedSources(
    `${origin.url}/to/${encodeURIComponent(`${elsewhere.url}/collect`)}`,
    { redirect: 'manual' }
  );

  assert.equal(response.status, 307);
  assert.deepEqual(elsewhere.seen, []);
});

test('forwards caller headers on every hop', async () => {
  const accepts = [];
  const target = await listen((request, response) => {
    accepts.push(request.headers.accept);
    request.resume();
    response.end('ok');
  });
  const origin = await listen((request, response) => {
    accepts.push(request.headers.accept);
    request.resume();
    response.writeHead(307, { location: `${target}/landing` });
    response.end();
  });

  await fetchWithTrustedSources(origin, {
    headers: { accept: 'text/markdown' },
  });

  assert.deepEqual(accepts, ['text/markdown', 'text/markdown']);
});
