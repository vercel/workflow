import { getCoreRuntimeRequire } from './package-require.js';

function parsePort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 65535) {
    return undefined;
  }

  return parsed;
}

async function getLocalPort(): Promise<number | undefined> {
  const envPort = parsePort(process.env.PORT);
  if (envPort !== undefined) {
    return envPort;
  }

  try {
    const loadedModule = getCoreRuntimeRequire()(
      ['@workflow', 'utils', 'get-port'].join('/')
    ) as { getPort?: () => Promise<number | undefined> };
    return await loadedModule.getPort?.();
  } catch {
    return undefined;
  }
}

export async function getBaseUrl(): Promise<string> {
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  const port = await getLocalPort();
  return `http://localhost:${port ?? 3000}`;
}
