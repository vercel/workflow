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

test('drops the caller’s own credentials when a hop leaves the origin', async () => {
  const seen = [];
  const record = (request) =>
    seen.push({
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      proxyAuthorization: request.headers['proxy-authorization'],
      accept: request.headers.accept,
    });
  const target = await listen((request, response) => {
    record(request);
    request.resume();
    response.end('ok');
  });
  const origin = await listen((request, response) => {
    record(request);
    request.resume();
    response.writeHead(307, { location: `${target}/landing` });
    response.end();
  });

  await fetchWithTrustedSources(origin, {
    headers: {
      authorization: 'Bearer caller',
      cookie: 'session=1',
      'proxy-authorization': 'Basic cHJveHk=',
      accept: 'text/html',
    },
  });

  assert.deepEqual(seen, [
    {
      authorization: 'Bearer caller',
      cookie: 'session=1',
      proxyAuthorization: 'Basic cHJveHk=',
      accept: 'text/html',
    },
    // Everything `fetch` would have stripped itself is gone; the rest rides on.
    {
      authorization: undefined,
      cookie: undefined,
      proxyAuthorization: undefined,
      accept: 'text/html',
    },
  ]);
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

/**
 * A fresh copy of the module that mints from a fake runner token endpoint
 * answering each request with the next of `replies` (a status, a JWT, or
 * `'hang'` for a request it never answers).
 */
async function withMintEndpoint(replies, run) {
  let requests = 0;
  const endpoint = await listen((request, response) => {
    request.resume();
    const reply = replies[Math.min(requests++, replies.length - 1)];
    // Accepts the request and never answers.
    if (reply === 'hang') return;
    if (typeof reply === 'number') {
      response.writeHead(reply).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ value: reply }));
  });
  const saved = { ...process.env };
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = `${endpoint}/mint`;
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'request-token';
  process.env.WORKFLOW_OIDC_MINT_RETRY_BASE_DELAY_MS = '1';
  process.env.WORKFLOW_OIDC_MINT_ATTEMPT_TIMEOUT_MS = '100';
  try {
    const module = await import(
      `./trusted-sources-headers.mjs?mint=${Math.random()}`
    );
    return await run(module, () => requests);
  } finally {
    process.env = saved;
  }
}

/** An unsigned JWT whose `exp` is `secondsFromNow` away. */
function jwt(secondsFromNow, id) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow, id })
  ).toString('base64url');
  return `e30.${payload}.sig`;
}

test('retries the runner token endpoint through 5xx and 429 answers', async () => {
  const minted = jwt(300, 'retried');
  const origin = await recordingOrigin();

  await withMintEndpoint([503, 500, 429, minted], async (module, requests) => {
    const response = await module.fetchWithTrustedSources(origin.url);
    assert.equal(response.status, 200);
    assert.equal(requests(), 4);
  });
  assert.deepEqual(origin.seen, [minted]);
});

test('does not retry a 4xx from the runner token endpoint', async () => {
  const origin = await recordingOrigin();

  await withMintEndpoint([403, jwt(300, 'never')], async (module, requests) => {
    await assert.rejects(
      module.fetchWithTrustedSources(origin.url),
      /Failed to mint GitHub Actions OIDC token: 403/
    );
    assert.equal(requests(), 1);
  });
  assert.deepEqual(origin.seen, []);
});

test('gives up after a bounded number of attempts', async () => {
  const origin = await recordingOrigin();

  await withMintEndpoint([503], async (module, requests) => {
    await assert.rejects(
      module.fetchWithTrustedSources(origin.url),
      /after 5 attempts: 503/
    );
    assert.equal(requests(), 5);
  });
});

test('retries an attempt the token endpoint never answers', async () => {
  const minted = jwt(300, 'after-hang');
  const origin = await recordingOrigin();

  await withMintEndpoint(['hang', minted], async (module, requests) => {
    const response = await module.fetchWithTrustedSources(origin.url);
    assert.equal(response.status, 200);
    assert.equal(requests(), 2);
  });
  assert.deepEqual(origin.seen, [minted]);
});

test('keeps a still-valid token when an early refresh fails, after one attempt', async () => {
  // Inside the early-refresh window, so the next request refreshes.
  const first = jwt(30, 'first');
  const origin = await recordingOrigin();

  await withMintEndpoint([first, 503], async (module, requests) => {
    await module.fetchWithTrustedSources(origin.url);
    const response = await module.fetchWithTrustedSources(origin.url);
    assert.equal(response.status, 200);
    // The refresh tried once instead of backing off with a token in hand.
    assert.equal(requests(), 2);
  });
  assert.deepEqual(origin.seen, [first, first]);
});
