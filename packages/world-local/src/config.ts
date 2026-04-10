import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getWorkflowPort } from '@workflow/utils/get-port';
import { once } from './util.js';

const execFileAsync = promisify(execFile);
const COMMAND_PORT_PATTERN =
  /(?:^|\s)(?:--port(?:=|\s+)|-p(?:=|\s+))(\d{1,5})(?=\s|$)/;
const MAX_ANCESTOR_PORT_SCAN_DEPTH = 6;
let cachedAncestorCommandPortPromise: Promise<number | undefined> | null = null;

const getDataDirFromEnv = () => {
  return process.env.WORKFLOW_LOCAL_DATA_DIR || '.workflow-data';
};

export const DEFAULT_RESOLVE_DATA_OPTION = 'all';

const getBaseUrlFromEnv = () => {
  return process.env.WORKFLOW_LOCAL_BASE_URL;
};

const getNextPrivateOriginFromEnv = () => {
  const origin = process.env.__NEXT_PRIVATE_ORIGIN;
  if (!origin) {
    return undefined;
  }

  return origin;
};

function getPortFromEnvVariable(name: string): number | undefined {
  return parsePort(process.env[name]);
}

function parsePort(value: string | undefined, radix = 10): number | undefined {
  if (!value) {
    return undefined;
  }
  const port = Number.parseInt(value, radix);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    return undefined;
  }
  return port;
}

function getPortFromCommand(command: string | undefined): number | undefined {
  if (!command) {
    return undefined;
  }

  const match = command.match(COMMAND_PORT_PATTERN);
  if (!match?.[1]) {
    return undefined;
  }

  return parsePort(match[1]);
}

function getPortFromLifecycleScript(): number | undefined {
  return getPortFromCommand(process.env.npm_lifecycle_script);
}

function getPortFromArgv(): number | undefined {
  if (process.argv.length === 0) {
    return undefined;
  }

  return getPortFromCommand(process.argv.join(' '));
}

async function getParentPid(pid: number): Promise<number | undefined> {
  if (process.platform === 'win32') {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync('ps', [
      '-o',
      'ppid=',
      '-p',
      String(pid),
    ]);
    const parentPid = parsePort(stdout.trim());
    if (typeof parentPid !== 'number' || parentPid <= 0) {
      return undefined;
    }
    return parentPid;
  } catch {
    return undefined;
  }
}

async function getPortFromPidCommand(pid: number): Promise<number | undefined> {
  if (process.platform === 'win32') {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync('ps', [
      '-o',
      'command=',
      '-p',
      String(pid),
    ]);
    return getPortFromCommand(stdout.trim());
  } catch {
    return undefined;
  }
}

async function getPortFromAncestorCommands(): Promise<number | undefined> {
  if (process.platform === 'win32') {
    return undefined;
  }

  let currentPid = process.pid;
  for (
    let depth = 0;
    depth < MAX_ANCESTOR_PORT_SCAN_DEPTH && currentPid > 1;
    depth++
  ) {
    const commandPort = await getPortFromPidCommand(currentPid);
    if (typeof commandPort === 'number') {
      return commandPort;
    }

    const parentPid = await getParentPid(currentPid);
    if (
      typeof parentPid !== 'number' ||
      parentPid <= 0 ||
      parentPid === currentPid
    ) {
      break;
    }

    currentPid = parentPid;
  }

  return undefined;
}

async function getCachedPortFromAncestorCommands(): Promise<
  number | undefined
> {
  if (!cachedAncestorCommandPortPromise) {
    cachedAncestorCommandPortPromise = getPortFromAncestorCommands().catch(
      () => undefined
    );
  }

  return cachedAncestorCommandPortPromise;
}

export type Config = {
  dataDir: string;
  port?: number;
  baseUrl?: string;
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
 * Resolves the base URL for queue requests following the priority order:
 * 1. config.baseUrl (highest priority - full override from args)
 * 2. WORKFLOW_LOCAL_BASE_URL env var (checked directly to handle late env var setting)
 * 3. __NEXT_PRIVATE_ORIGIN env var (Next.js internal server origin)
 * 4. config.port (explicit port override from args)
 * 5. PORT env var (explicit configuration)
 * 6. TURBO_PORT env var (set by turbo task runner in some monorepos)
 * 7. npm_lifecycle_script --port/-p value (when dev script encodes the port)
 * 8. process.argv --port/-p value
 * 9. Ancestor process command --port/-p value (for detached worker contexts)
 * 10. Auto-detected port via getPort (detect actual listening port)
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

  // Next.js sets this internal origin env var for server-side internal fetches.
  // In dev, workflow queue calls can run in worker processes that are not the
  // listening server process, so PORT/getWorkflowPort may be unavailable there.
  const nextPrivateOrigin = getNextPrivateOriginFromEnv();
  if (nextPrivateOrigin) {
    return nextPrivateOrigin;
  }

  if (typeof config.port === 'number') {
    return `http://localhost:${config.port}`;
  }

  if (process.env.PORT) {
    return `http://localhost:${process.env.PORT}`;
  }

  const turboPort = getPortFromEnvVariable('TURBO_PORT');
  if (typeof turboPort === 'number') {
    return `http://localhost:${turboPort}`;
  }

  const lifecyclePort = getPortFromLifecycleScript();
  if (typeof lifecyclePort === 'number') {
    return `http://localhost:${lifecyclePort}`;
  }

  const argvPort = getPortFromArgv();
  if (typeof argvPort === 'number') {
    return `http://localhost:${argvPort}`;
  }

  const ancestorCommandPort = await getCachedPortFromAncestorCommands();
  if (typeof ancestorCommandPort === 'number') {
    return `http://localhost:${ancestorCommandPort}`;
  }

  const detectedPort = await getWorkflowPort();
  if (detectedPort) {
    return `http://localhost:${detectedPort}`;
  }

  throw new Error('Unable to resolve base URL for workflow queue.');
}
