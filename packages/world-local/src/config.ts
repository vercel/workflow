import { once } from './util.js';

const getDataDirFromEnv = () => {
  return process.env.WORKFLOW_EMBEDDED_DATA_DIR || '.workflow-data';
};

export const DEFAULT_RESOLVE_DATA_OPTION = 'all';

const getBaseUrlFromEnv = () => {
  const baseUrl = process.env.WORKFLOW_BASE_URL;
  if (!baseUrl) {
    return null;
  }

  try {
    const url = new URL(baseUrl);
    // NOTE: Preserve any path segments so deployments behind a proxy keep working,
    // while trimming the trailing slash to avoid accidental double slashes.
    return url.href.replace(/\/$/, '');
  } catch {
    throw new Error(`Invalid WORKFLOW_BASE_URL: ${baseUrl}`);
  }
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
