import { getWorkflowPort } from '@workflow/utils/get-port';
import { once } from './util.js';

const getDataDirFromEnv = () => {
  return process.env.WORKFLOW_LOCAL_DATA_DIR || '.workflow-data';
};

export const DEFAULT_RESOLVE_DATA_OPTION = 'all';

const getBaseUrlFromEnv = () => {
  return process.env.WORKFLOW_LOCAL_BASE_URL;
};

export type Config = {
  dataDir: string;
  port?: number;
  baseUrl?: string;
};

export const config = once<Config>(() => {
  const dataDir = getDataDirFromEnv();
  const baseUrl = getBaseUrlFromEnv();

  return { dataDir, baseUrl };
});

/**
 * Resolves the base URL for queue requests following the priority order:
 * 1. config.baseUrl (highest priority - full override from args)
 * 2. WORKFLOW_LOCAL_BASE_URL env var (checked directly to handle late env var setting)
 * 3. config.port (explicit port override from args)
 * 4. PORT env var (explicit configuration)
 * 5. Auto-detected port via getPort (detect actual listening port)
 */
export async function resolveBaseUrl(config: Partial<Config>): Promise<string> {
  if (config.baseUrl) {
    return config.baseUrl;
  }

  // Check env var directly in case it was set after the config was cached
  // This is important for CLI tools that set the env var after module import
  if (process.env.WORKFLOW_LOCAL_BASE_URL) {
    return process.env.WORKFLOW_LOCAL_BASE_URL;
  }

  if (typeof config.port === 'number') {
    return `http://localhost:${config.port}`;
  }

  if (process.env.PORT) {
    return `http://localhost:${process.env.PORT}`;
  }

  const detectedPort = await getWorkflowPort();
  if (detectedPort) {
    return `http://localhost:${detectedPort}`;
  }

  throw new Error('Unable to resolve base URL for workflow queue.');
}
