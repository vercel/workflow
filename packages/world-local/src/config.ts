import { once } from './util.js';

const getDataDirFromEnv = () => {
  return process.env.WORKFLOW_EMBEDDED_DATA_DIR || '.workflow-data';
};

export const DEFAULT_RESOLVE_DATA_OPTION = 'all';

const getPortFromEnv = () => {
  const port = process.env.PORT;
  if (port) {
    return Number(port);
  }
  //
  return 3000;
};

const getBaseUrlFromEnv = () => {
  const baseUrl = process.env.WORKFLOW_EMBEDDED_BASE_URL;
  if (baseUrl) {
    return baseUrl;
  }
  const port = getPortFromEnv();
  return `http://localhost:${port}`;
};

export type Config = {
  dataDir: string;
  port: number;
  baseUrl: string;
};

export const config = once<Config>(() => {
  const dataDir = getDataDirFromEnv();
  const port = getPortFromEnv();
  const baseUrl = getBaseUrlFromEnv();

  return { dataDir, port, baseUrl };
});
