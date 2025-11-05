import { once } from './util.js';

const getDataDirFromEnv = () => {
  return process.env.WORKFLOW_EMBEDDED_DATA_DIR || '.workflow-data';
};

export const DEFAULT_RESOLVE_DATA_OPTION = 'all';

export const normalizeBaseUrl = (
  value: string,
  sourceLabel = 'baseUrl' // NOTE: Should I keep this? This helps us throw errors like Invalid baseUrl: … or WORKFLOW_BASE_URL cannot be empty
) => {
  const candidate = value.trim();
  if (candidate.length === 0) {
    throw new Error(`${sourceLabel} cannot be empty`);
  }

  try {
    const url = new URL(candidate);
    // Preserve any path segments (for reverse proxies) but trim trailing slashes to avoid duplicates.
    return url.href.replace(/\/+$/, '');
  } catch {
    throw new Error(`Invalid ${sourceLabel}: ${value}`);
  }
};

const getBaseUrlFromEnv = () => {
  const baseUrl = process.env.WORKFLOW_BASE_URL;
  if (!baseUrl) {
    return null;
  }

  return normalizeBaseUrl(baseUrl, 'WORKFLOW_BASE_URL');
};

const getPortFromEnv = () => {
  const port = process.env.PORT;
  if (port) {
    return Number(port);
  }
  //
  return 3000;
};

export const config = once(() => {
  const dataDir = getDataDirFromEnv();
  const port = getPortFromEnv();
  const baseUrl = getBaseUrlFromEnv();

  return { dataDir, port, baseUrl };
});
