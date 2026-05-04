/**
 * Tarballs smoke checks.
 *
 * Validates that the deployed tarballs project is publicly accessible
 * (no Vercel Deployment Protection) and serving the expected `*.tgz`
 * files with a valid gzip signature. The project must be publicly
 * reachable for `pnpm install` to fetch tarball URLs from a third-party
 * project, so the smoke checks make no attempt to send a bypass token —
 * if a check fails behind a login redirect, the project is misconfigured.
 *
 * Requires DEPLOYMENT_URL to point at the tarballs deployment.
 */

const rawBaseUrl = process.env.DEPLOYMENT_URL || '';
if (!rawBaseUrl) {
  console.error('DEPLOYMENT_URL is required');
  process.exit(1);
}
const BASE_URL = rawBaseUrl.startsWith('http')
  ? rawBaseUrl
  : `https://${rawBaseUrl}`;

const GZIP_SIGNATURE = [0x1f, 0x8b];

const assertNoProtection = async (path) => {
  const res = await fetch(`${BASE_URL}${path}`, { redirect: 'manual' });
  const location = res.headers.get('location') || '';
  if (
    res.status === 307 &&
    (location.includes('vercel.com/login') ||
      location.includes('/_vercel/login'))
  ) {
    throw new Error(
      `${path} redirected to Vercel login — the tarballs project must be publicly accessible (disable Deployment Protection)`
    );
  }
};

const assertTgzResponse = async (path) => {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) {
    throw new Error(`${path} returned ${res.status}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  for (let i = 0; i < GZIP_SIGNATURE.length; i += 1) {
    if (buf[i] !== GZIP_SIGNATURE[i]) {
      throw new Error(`${path} did not start with gzip signature bytes`);
    }
  }
};

const assertHtmlResponse = async (path) => {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) {
    throw new Error(`${path} returned ${res.status}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    throw new Error(`${path} content-type was ${contentType}`);
  }
};

const checks = [
  {
    name: 'Deployment protection',
    run: () => assertNoProtection('/workflow.tgz'),
  },
  {
    name: 'Index page',
    run: () => assertHtmlResponse('/'),
  },
  {
    name: 'Tarball - workflow',
    run: () => assertTgzResponse('/workflow.tgz'),
  },
  {
    name: 'Tarball - workflow-core',
    run: () => assertTgzResponse('/workflow-core.tgz'),
  },
  {
    name: 'Tarball - workflow-next',
    run: () => assertTgzResponse('/workflow-next.tgz'),
  },
];

const run = async () => {
  for (const check of checks) {
    console.log(`Running tarballs smoke check: ${check.name}`);
    await check.run();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
