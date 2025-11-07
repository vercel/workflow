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
  return undefined;
};

export const config = once(() => {
  const dataDir = getDataDirFromEnv();
  const port = getPortFromEnv();

  return { dataDir, port };
});
