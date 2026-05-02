/**
 * Tarballs smoke checks.
 *
 * Validates that the deployed tarballs project is serving the expected
 * `*.tgz` files at the project root with valid gzip signature bytes.
 *
 * Requires DEPLOYMENT_URL to point at the tarballs deployment. If the
 * deployment is behind Vercel deployment protection, set
 * VERCEL_AUTOMATION_BYPASS_SECRET.
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

const assertTgzResponse = async (path) => {
  const res = await fetch(`${BASE_URL}${path}`, { headers: getHeaders() });
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

const checks = [
  {
    name: 'Deployment protection',
    run: () => assertNoProtection('/workflow.tgz'),
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
