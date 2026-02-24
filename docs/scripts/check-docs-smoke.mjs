import { spawn } from 'node:child_process';

/**
 * Docs smoke checks.
 *
 * This script is intentionally small and dependency-free so it can run in CI.
 * It validates critical public endpoints (OG images and sitemap) and can be
 * extended with more lightweight checks over time.
 *
 * When DEPLOYMENT_URL or OG_BASE_URL is set, it targets a remote deployment.
 * Otherwise it starts the local docs server and tests against localhost.
 */

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

const assertNoProtection = async (path) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    redirect: 'manual',
    headers: getHeaders(),
  });
  const location = res.headers.get('location') || '';
  if (
    res.status === 307 &&
    (location.includes('vercel.com/login') ||
      location.includes('/_vercel/login'))
  ) {
    throw new Error(
      `${path} redirected to Vercel login; check deployment protection/bypass`
    );
  }
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

const assertHtmlMeta = async (path, expectedOgImagePath) => {
  const res = await fetch(`${BASE_URL}${path}`, { headers: getHeaders() });
  if (!res.ok) {
    throw new Error(`${path} returned ${res.status}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    throw new Error(`${path} content-type was ${contentType}`);
  }
  const html = await res.text();
  const ogImage = html.match(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i
  )?.[1];
  if (!ogImage) {
    throw new Error(`${path} missing og:image meta tag`);
  }
  if (expectedOgImagePath) {
    const normalized = ogImage.startsWith('http')
      ? new URL(ogImage).pathname
      : ogImage;
    if (normalized !== expectedOgImagePath) {
      throw new Error(
        `${path} og:image was ${ogImage}, expected ${expectedOgImagePath}`
      );
    }
  }
  const twitterImage = html.match(
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i
  )?.[1];
  if (!twitterImage) {
    throw new Error(`${path} missing twitter:image meta tag`);
  }
  if (expectedOgImagePath) {
    const normalized = twitterImage.startsWith('http')
      ? new URL(twitterImage).pathname
      : twitterImage;
    if (normalized !== expectedOgImagePath) {
      throw new Error(
        `${path} twitter:image was ${twitterImage}, expected ${expectedOgImagePath}`
      );
    }
  }
  const ogTitle = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i
  )?.[1];
  if (!ogTitle) {
    throw new Error(`${path} missing og:title meta tag`);
  }
  const ogDescription = html.match(
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i
  )?.[1];
  if (!ogDescription) {
    throw new Error(`${path} missing og:description meta tag`);
  }
};

const checks = [
  {
    name: 'Deployment protection',
    run: () => assertNoProtection('/og'),
  },
  {
    name: 'OG default image',
    run: () => assertPngResponse('/og'),
  },
  {
    name: 'HTML meta - docs root',
    run: () => assertHtmlMeta('/docs', '/og/getting-started/image.png'),
  },
  {
    name: 'HTML meta - docs idempotency',
    run: () =>
      assertHtmlMeta(
        '/docs/foundations/idempotency',
        '/og/foundations/idempotency/image.png'
      ),
  },
  {
    name: 'HTML meta - docs common patterns',
    run: () =>
      assertHtmlMeta(
        '/docs/foundations/common-patterns',
        '/og/foundations/common-patterns/image.png'
      ),
  },
  {
    name: 'HTML meta - docs get-writable',
    run: () =>
      assertHtmlMeta(
        '/docs/api-reference/workflow/get-writable',
        '/og/api-reference/workflow/get-writable/image.png'
      ),
  },
  {
    name: 'HTML meta - worlds index',
    run: () => assertHtmlMeta('/worlds', '/og/worlds'),
  },
  {
    name: 'HTML meta - world local',
    run: () => assertHtmlMeta('/worlds/local', '/og/worlds/local'),
  },
  {
    name: 'HTML meta - world postgres',
    run: () => assertHtmlMeta('/worlds/postgres', '/og/worlds/postgres'),
  },
  {
    name: 'HTML meta - world vercel',
    run: () => assertHtmlMeta('/worlds/vercel', '/og/worlds/vercel'),
  },
  {
    name: 'OG docs page image',
    run: () => assertPngResponse('/og/foundations/idempotency/image.png'),
  },
  {
    name: 'OG docs root image',
    run: () => assertPngResponse('/og/getting-started/image.png'),
  },
  {
    name: 'OG docs foundations image',
    run: () => assertPngResponse('/og/foundations/common-patterns/image.png'),
  },
  {
    name: 'OG docs reference image',
    run: () => assertPngResponse('/og/api-reference/workflow/get-writable/image.png'),
  },
  {
    name: 'OG worlds index image',
    run: () => assertPngResponse('/og/worlds'),
  },
  {
    name: 'OG world image (local)',
    run: () => assertPngResponse('/og/worlds/local'),
  },
  {
    name: 'OG world image (postgres)',
    run: () => assertPngResponse('/og/worlds/postgres'),
  },
  {
    name: 'OG world image (vercel)',
    run: () => assertPngResponse('/og/worlds/vercel'),
  },
  {
    name: 'Sitemap',
    run: () => assertXmlResponse('/sitemap.xml'),
  },
];

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
    for (const check of checks) {
      console.log(`Running docs smoke check: ${check.name}`);
      await check.run();
    }
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
