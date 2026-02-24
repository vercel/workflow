import { spawn } from 'node:child_process';

const PORT = process.env.OG_TEST_PORT || '3100';
const HOST = '127.0.0.1';
const rawBaseUrl = process.env.DEPLOYMENT_URL || process.env.OG_BASE_URL || '';
const BASE_URL = rawBaseUrl
  ? rawBaseUrl.startsWith('http')
    ? rawBaseUrl
    : `https://${rawBaseUrl}`
  : `http://${HOST}:${PORT}`;
const USE_REMOTE = Boolean(rawBaseUrl);
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getHeaders = () => {
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    return { 'x-vercel-protection-bypass': bypassSecret };
  }
  return {};
};

const waitForServer = async (url, timeoutMs = 30_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url, { headers: getHeaders() });
      if (res.ok) return;
    } catch {
      // ignore until server is ready
    }
    await wait(500);
  }
  throw new Error(`Timed out waiting for server at ${url}`);
};

const assertPngResponse = async (path) => {
  const res = await fetch(`${BASE_URL}${path}`, { headers: getHeaders() });
  if (!res.ok) {
    throw new Error(`${path} returned ${res.status}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('image/png')) {
    throw new Error(`${path} content-type was ${contentType}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (buf[i] !== PNG_SIGNATURE[i]) {
      throw new Error(`${path} did not start with PNG signature bytes`);
    }
  }
};

const assertXmlResponse = async (path) => {
  const res = await fetch(`${BASE_URL}${path}`, { headers: getHeaders() });
  if (!res.ok) {
    throw new Error(`${path} returned ${res.status}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('xml') && !contentType.includes('text/plain')) {
    throw new Error(`${path} content-type was ${contentType}`);
  }
  const text = await res.text();
  if (!text.includes('<?xml')) {
    throw new Error(`${path} did not contain xml declaration`);
  }
};

const run = async () => {
  let child = null;
  let stopServer = async () => {};
  let cleanup = async () => {};

  if (!USE_REMOTE) {
    child = spawn('pnpm', ['-C', 'docs', 'start'], {
      env: {
        ...process.env,
        PORT,
        HOSTNAME: HOST,
      },
      stdio: 'inherit',
    });

    let shuttingDown = false;
    stopServer = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        wait(5_000),
      ]);
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    };

    cleanup = async () => {
      try {
        await stopServer();
      } catch {
        // ignore cleanup errors
      }
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('exit', cleanup);
  }

  try {
    await waitForServer(`${BASE_URL}/og`);
    await assertPngResponse('/og');
    await assertPngResponse('/og/foundations/idempotency/image.png');
    await assertXmlResponse('/sitemap.xml');
    await stopServer();
  } catch (error) {
    await stopServer();
    throw error;
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
