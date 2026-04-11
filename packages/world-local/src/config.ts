import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { getWorkflowPort } from '@workflow/utils/get-port';
import { once } from './util.js';

const execFileAsync = promisify(execFile);
const COMMAND_PORT_PATTERN =
  /(?:^|\s)(?:--port(?:=|\s+)|-p(?:=|\s+))(\d{1,5})(?=\s|$)/g;
const MAX_ANCESTOR_PORT_SCAN_DEPTH = 6;
let cachedAncestorCommandPort: number | undefined;

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
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  return port;
}

function getPortFromCommand(command: string | undefined): number | undefined {
  if (!command) {
    return undefined;
  }

  const matches = Array.from(command.matchAll(COMMAND_PORT_PATTERN));
  if (matches.length === 0) {
    return undefined;
  }

  // Node/Next scripts can contain repeated `--port` flags (e.g. script default
  // plus CLI override). Use the last match, which matches CLI precedence.
  const lastMatch = matches[matches.length - 1];
  if (!lastMatch?.[1]) {
    return undefined;
  }

  return parsePort(lastMatch[1]);
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
  if (typeof cachedAncestorCommandPort === 'number') {
    return cachedAncestorCommandPort;
  }

  const resolvedPort = await getPortFromAncestorCommands();
  if (typeof resolvedPort === 'number') {
    cachedAncestorCommandPort = resolvedPort;
  }
  return resolvedPort;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function getProjectRootFromDataDir(
  dataDir: string | undefined
): string | undefined {
  if (!dataDir) {
    return undefined;
  }

  const normalized = normalizePath(resolve(dataDir));

  const nextSuffix = '/.next/workflow-data';
  if (normalized.endsWith(nextSuffix)) {
    return normalized.slice(0, -nextSuffix.length);
  }

  const fallbackSuffix = '/.workflow-data';
  if (normalized.endsWith(fallbackSuffix)) {
    return normalized.slice(0, -fallbackSuffix.length);
  }

  return undefined;
}

async function getPortFromProjectProcessList(
  projectRoot: string | undefined
): Promise<number | undefined> {
  if (!projectRoot || process.platform === 'win32') {
    return undefined;
  }

  const isCommandWithinProjectRoot = (
    command: string,
    normalizedProjectRoot: string
  ): boolean => {
    return (
      command.includes(`${normalizedProjectRoot}/`) ||
      command.includes(`${normalizedProjectRoot} `) ||
      command.endsWith(normalizedProjectRoot)
    );
  };

  const getProcessCwd = async (pid: number): Promise<string | undefined> => {
    const { stdout: cwdOutput } = await execFileAsync('lsof', [
      '-a',
      '-p',
      String(pid),
      '-d',
      'cwd',
      '-Fn',
    ]).catch(() => ({ stdout: '' as string }));
    const cwdLine = cwdOutput
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('n'));
    if (!cwdLine || cwdLine.length < 2) {
      return undefined;
    }
    return normalizePath(cwdLine.slice(1));
  };

  const isHttpReachablePort = async (port: number): Promise<boolean> => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300);
      const response = await fetch(`http://localhost:${port}/`, {
        method: 'HEAD',
        signal: controller.signal,
      }).catch(async () => {
        return await fetch(`http://localhost:${port}/`, {
          method: 'GET',
          signal: controller.signal,
        });
      });
      clearTimeout(timeout);
      return response.status >= 100 && response.status < 600;
    } catch {
      return false;
    }
  };

  try {
    const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,command=']);
    const normalizedProjectRoot = normalizePath(projectRoot);

    const nextDevCommands: Array<{ pid: number; command: string }> = [];
    const processEntries = stdout
      .split('\n')
      .map((entry) => entry.trim())
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match?.[1] || !match[2]) {
          return null;
        }
        const pid = Number.parseInt(match[1], 10);
        if (!Number.isFinite(pid)) {
          return null;
        }
        return {
          pid,
          command: match[2],
        };
      })
      .filter((entry): entry is { pid: number; command: string } =>
        Boolean(entry)
      )
      .sort((a, b) => b.pid - a.pid);

    for (const { pid, command } of processEntries) {
      if (command.includes('detached-flush')) {
        continue;
      }

      const looksLikeNextDevProcess =
        command.includes('next') &&
        (command.includes(' dev') || command.includes('next-server'));
      if (!looksLikeNextDevProcess) {
        continue;
      }

      let matchesProject = isCommandWithinProjectRoot(
        command,
        normalizedProjectRoot
      );
      if (!matchesProject) {
        const processCwd = await getProcessCwd(pid);
        matchesProject = processCwd === normalizedProjectRoot;
      }
      if (!matchesProject) {
        continue;
      }

      nextDevCommands.push({ pid, command });
    }

    const candidatePorts: number[] = [];
    const addCandidatePort = (port: number) => {
      if (!candidatePorts.includes(port)) {
        candidatePorts.push(port);
      }
    };

    for (const entry of nextDevCommands) {
      const parsedPort = getPortFromCommand(entry.command);
      if (typeof parsedPort === 'number') {
        addCandidatePort(parsedPort);
      }

      const { stdout: lsofOutput } = await execFileAsync('lsof', [
        '-a',
        '-i',
        '-P',
        '-n',
        '-p',
        String(entry.pid),
        '-sTCP:LISTEN',
      ]).catch(() => ({ stdout: '' as string }));
      const lsofLines = lsofOutput.split('\n');
      for (const lsofLine of lsofLines) {
        const parts = lsofLine.trim().split(/\s+/);
        const address = parts[8];
        if (!address) {
          continue;
        }
        const colonIndex = address.lastIndexOf(':');
        if (colonIndex === -1) {
          continue;
        }
        const parsedLsofPort = parsePort(address.slice(colonIndex + 1));
        if (typeof parsedLsofPort === 'number') {
          addCandidatePort(parsedLsofPort);
        }
      }
    }

    for (const candidatePort of candidatePorts) {
      if (await isHttpReachablePort(candidatePort)) {
        return candidatePort;
      }
    }

    if (candidatePorts.length > 0) {
      return candidatePorts[0];
    }

    return undefined;
  } catch {
    return undefined;
  }
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
 * 9. Process list lookup by WORKFLOW_LOCAL_DATA_DIR project root (multi-worker fallback)
 * 10. Ancestor process command --port/-p value (for detached worker contexts)
 * 11. Auto-detected port via getPort (detect actual listening port)
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
    const parsedConfigPort = parsePort(String(config.port));
    if (typeof parsedConfigPort === 'number') {
      return `http://localhost:${parsedConfigPort}`;
    }
  }

  const envPort = parsePort(process.env.PORT);
  if (typeof envPort === 'number') {
    return `http://localhost:${envPort}`;
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

  const projectRoot = getProjectRootFromDataDir(config.dataDir);
  const projectProcessPort = await getPortFromProjectProcessList(projectRoot);
  if (typeof projectProcessPort === 'number') {
    return `http://localhost:${projectProcessPort}`;
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
