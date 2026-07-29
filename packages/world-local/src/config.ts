import {
  createWorkflowBaseUrl,
  createWorkflowHealthEndpoint,
} from '@workflow/utils';
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
  /**
   * Whether start() should re-enqueue pending/running runs from storage.
   * Defaults to true; the `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS` env var is
   * used as a fallback when this option is unset. Test harnesses that always
   * start from a clean slate can disable recovery to avoid replaying stale
   * runs.
   */
  recoverActiveRuns?: boolean;
  /**
   * Optional tag to scope filesystem operations.
   * When set, files are written as `{id}.{tag}.json` and `clear()` only deletes
   * files matching this tag. Used by vitest to isolate test data in the shared
   * `.workflow-data` directory.
   */
  tag?: string;
  /**
   * Override the flush interval (in ms) for buffered stream writes.
   * Default is 10ms. Set to 0 for immediate flushing.
   */
  streamFlushIntervalMs?: number;
};

export const config = once<Config>(() => {
  const dataDir = getDataDirFromEnv();
  const baseUrl = getBaseUrlFromEnv();

  return { dataDir, baseUrl };
});

/**
 * Resolves whether start() should re-enqueue pending/running runs from
 * storage, following the priority order:
 * 1. config.recoverActiveRuns (explicit factory option)
 * 2. WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS env var (`0`/`false` disables,
 *    `1`/`true` enables; read lazily to handle late env var setting)
 * 3. Default: true
 *
 * An unrecognized env value falls through to the default — the env var is an
 * escape hatch, not a hard requirement.
 */
export function resolveRecoverActiveRuns(config: Partial<Config>): boolean {
  if (config.recoverActiveRuns !== undefined) {
    return config.recoverActiveRuns;
  }
  const raw = process.env.WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS?.toLowerCase();
  if (raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  return true;
}

export function resolveDirectBaseUrl(config: Partial<Config>): string {
  return (
    config.baseUrl ??
    process.env.WORKFLOW_LOCAL_BASE_URL ??
    createWorkflowBaseUrl('http://localhost')
  );
}

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
    return createWorkflowBaseUrl(`http://localhost:${config.port}`);
  }

  if (process.env.PORT) {
    return createWorkflowBaseUrl(`http://localhost:${process.env.PORT}`);
  }

  const detectedPort = await getWorkflowPort({
    endpoint: createWorkflowHealthEndpoint(),
  });
  if (detectedPort) {
    return createWorkflowBaseUrl(`http://localhost:${detectedPort}`);
  }

  throw new Error('Unable to resolve base URL for workflow queue.');
}
