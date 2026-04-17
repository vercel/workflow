import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { transform } from '@swc/core';
import {
  parseMessage,
  type SocketMessage,
  serializeMessage,
} from './socket-server.js';
import {
  DEFERRED_STEP_SOURCE_METADATA_PREFIX,
  isDeferredStepCopyFilePath,
  parseDeferredStepSourceMetadata,
  parseInlineSourceMapComment,
} from './step-copy-utils.js';

type DecoratorOptionsWithConfigPath =
  import('@workflow/builders').DecoratorOptionsWithConfigPath;
type WorkflowPatternMatch = import('@workflow/builders').WorkflowPatternMatch;

// Cache decorator options per working directory to avoid reading tsconfig for every file
const decoratorOptionsCache = new Map<
  string,
  Promise<DecoratorOptionsWithConfigPath>
>();
// Cache for shared utilities from @workflow/builders (ESM module loaded dynamically in CommonJS context)
let cachedBuildersModule: typeof import('@workflow/builders') | null = null;
type LoaderStaticDependencies = {
  swcPluginPath: string;
  files: string[];
};
let cachedLoaderStaticDependencies: LoaderStaticDependencies | null = null;

type DiscoveredPatternState = {
  hasWorkflow: boolean;
  hasStep: boolean;
  hasSerde: boolean;
};
const discoveredPatternStateByFilePath = new Map<
  string,
  DiscoveredPatternState
>();

// Cache socket connection to avoid reconnecting on every file.
let socketClientPromise: Promise<Socket | null> | null = null;
let socketClient: Socket | null = null;
let socketClientKey: string | null = null;

type SocketCredentials = {
  port: number;
  authToken: string;
};

const ROUTE_STUB_FILE_MARKER = 'WORKFLOW_ROUTE_STUB_FILE';
const ROUTE_STUB_BUILD_WAIT_TIMEOUT_MS = 120_000;
let pendingDeferredRouteStubBuildPromise: Promise<void> | null = null;

function registerFileDependency(
  loaderContext: WorkflowLoaderContext,
  dependencyPath: string
): void {
  loaderContext.addDependency?.(dependencyPath);
  loaderContext.addBuildDependency?.(dependencyPath);
}

function updateDiscoveredPatternState(
  filePath: string,
  nextState: DiscoveredPatternState
): { shouldNotify: boolean; previousState?: DiscoveredPatternState } {
  const previousState = discoveredPatternStateByFilePath.get(filePath);
  const hasAnyPattern =
    nextState.hasWorkflow || nextState.hasStep || nextState.hasSerde;

  if (!hasAnyPattern) {
    if (!previousState) {
      return { shouldNotify: false };
    }
    discoveredPatternStateByFilePath.delete(filePath);
    return { shouldNotify: true, previousState };
  }

  if (
    previousState &&
    previousState.hasWorkflow === nextState.hasWorkflow &&
    previousState.hasStep === nextState.hasStep &&
    previousState.hasSerde === nextState.hasSerde
  ) {
    return { shouldNotify: false, previousState };
  }

  discoveredPatternStateByFilePath.set(filePath, nextState);
  return { shouldNotify: true, previousState };
}

function addIfExists(files: Set<string>, dependencyPath: string): void {
  if (existsSync(dependencyPath)) {
    files.add(dependencyPath);
  }
}

function resolveLoaderStaticDependencies(): LoaderStaticDependencies {
  if (cachedLoaderStaticDependencies) {
    return cachedLoaderStaticDependencies;
  }

  const swcPluginPath = require.resolve('@workflow/swc-plugin');
  const swcPluginBuildHashPath = require.resolve(
    '@workflow/swc-plugin/build-hash.json'
  );
  const workflowBuildersPath = require.resolve('@workflow/builders');

  // Derive package.json paths from resolved entrypoints to avoid
  // Turbopack loader-eval failures around ../package.json resolution.
  const swcPluginPackageJsonPath = join(dirname(swcPluginPath), 'package.json');
  const workflowBuildersPackageJsonPath = join(
    dirname(workflowBuildersPath),
    '../package.json'
  );

  const files = new Set<string>([
    __filename,
    require.resolve('./socket-server'),
    require.resolve('./step-copy-utils'),
    swcPluginPath,
    swcPluginBuildHashPath,
    workflowBuildersPath,
  ]);
  addIfExists(files, swcPluginPackageJsonPath);
  addIfExists(files, workflowBuildersPackageJsonPath);

  cachedLoaderStaticDependencies = {
    swcPluginPath,
    files: Array.from(files),
  };
  return cachedLoaderStaticDependencies;
}

function registerTransformDependencies(
  loaderContext: WorkflowLoaderContext
): string {
  const staticDependencies = resolveLoaderStaticDependencies();
  for (const dependencyPath of staticDependencies.files) {
    registerFileDependency(loaderContext, dependencyPath);
  }

  return staticDependencies.swcPluginPath;
}

function resetSocketClient(cachedSocket?: Socket): void {
  if (cachedSocket && socketClient && socketClient !== cachedSocket) {
    return;
  }

  socketClientPromise = null;
  socketClient = null;
  socketClientKey = null;
}

async function writeSocketMessage(
  socket: Socket,
  message: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(message, (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function getSocketInfoFilePath(): string | null {
  const configuredPath = process.env.WORKFLOW_SOCKET_INFO_PATH;
  if (configuredPath) {
    return configuredPath;
  }

  // Fallback for worker processes that don't inherit dynamic env updates
  // from the process that created the socket server.
  const distDir = process.env.WORKFLOW_NEXT_DIST_DIR || '.next';
  const cwdFallbackPath = join(
    process.cwd(),
    distDir,
    'cache',
    'workflow-socket.json'
  );
  const projectRoot = process.env.WORKFLOW_PROJECT_ROOT;
  if (projectRoot) {
    const projectRootFallbackPath = join(
      projectRoot,
      distDir,
      'cache',
      'workflow-socket.json'
    );
    if (existsSync(projectRootFallbackPath)) {
      return projectRootFallbackPath;
    }
  }
  return cwdFallbackPath;
}

function getSocketCredentialsFromEnv(): SocketCredentials | null {
  const socketPort = process.env.WORKFLOW_SOCKET_PORT;
  const authToken = process.env.WORKFLOW_SOCKET_AUTH;
  if (!socketPort || !authToken) {
    return null;
  }

  const port = Number.parseInt(socketPort, 10);
  if (Number.isNaN(port)) {
    return null;
  }
  return { port, authToken };
}

async function getSocketCredentialsFromFile(): Promise<SocketCredentials | null> {
  const socketInfoFilePath = getSocketInfoFilePath();
  if (!socketInfoFilePath) {
    return null;
  }
  if (!existsSync(socketInfoFilePath)) {
    return null;
  }

  try {
    const raw = await readFile(socketInfoFilePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      port?: unknown;
      authToken?: unknown;
    };
    const authToken =
      typeof parsed.authToken === 'string' ? parsed.authToken : null;
    const numericPort =
      typeof parsed.port === 'number'
        ? parsed.port
        : Number.parseInt(String(parsed.port), 10);

    if (!authToken || Number.isNaN(numericPort)) {
      return null;
    }
    return {
      port: numericPort,
      authToken,
    };
  } catch {
    return null;
  }
}

async function getSocketCredentials(): Promise<SocketCredentials | null> {
  const envCredentials = getSocketCredentialsFromEnv();
  if (envCredentials) {
    return envCredentials;
  }
  return await getSocketCredentialsFromFile();
}

async function getSocketClient(): Promise<Socket | null> {
  const socketCredentials = await getSocketCredentials();
  if (!socketCredentials) {
    return null;
  }

  if (socketClient?.destroyed) {
    resetSocketClient(socketClient);
  }

  const currentSocketKey = `${socketCredentials.port}:${socketCredentials.authToken}`;
  if (socketClientKey && socketClientKey !== currentSocketKey) {
    if (socketClient) {
      resetSocketClient(socketClient);
    } else {
      resetSocketClient();
    }
  }

  if (!socketClientPromise) {
    socketClientPromise = (async () => {
      try {
        const socket = connect({
          port: socketCredentials.port,
          host: '127.0.0.1',
        });

        // Wait for connection
        await new Promise<void>((resolve, reject) => {
          const onConnect = () => {
            socket.setNoDelay(true);
            cleanup();
            resolve();
          };
          const onError = (error: Error) => {
            cleanup();
            reject(error);
          };
          const timeout = setTimeout(() => {
            cleanup();
            socket.destroy();
            reject(new Error('Socket connection timeout'));
          }, 1000);
          const cleanup = () => {
            clearTimeout(timeout);
            socket.off('connect', onConnect);
            socket.off('error', onError);
          };

          socket.on('connect', onConnect);
          socket.on('error', onError);
        });

        socket.on('close', () => {
          resetSocketClient(socket);
        });
        socket.on('error', () => {
          resetSocketClient(socket);
        });

        socketClient = socket;
        socketClientKey = currentSocketKey;
        return socket;
      } catch (error) {
        resetSocketClient();
        throw error;
      }
    })();
  }
  return socketClientPromise;
}

async function notifySocketServer(
  filename: string,
  hasWorkflow: boolean,
  hasStep: boolean,
  hasSerde: boolean
): Promise<void> {
  const socketCredentials = await getSocketCredentials();
  if (!socketCredentials) {
    return;
  }

  const socket = await getSocketClient();
  if (!socket) {
    throw new Error('Invariant: missing workflow socket connection');
  }

  const message: SocketMessage = {
    type: 'file-discovered',
    filePath: filename,
    hasWorkflow,
    hasStep,
    hasSerde,
  };
  const serializedMessage = serializeMessage(
    message,
    socketCredentials.authToken
  );

  try {
    await writeSocketMessage(socket, serializedMessage);
  } catch (error) {
    resetSocketClient(socket);
    const reconnectedSocket = await getSocketClient();
    if (!reconnectedSocket) {
      throw error;
    }
    await writeSocketMessage(reconnectedSocket, serializedMessage);
  }
}

function isWorkflowRouteStubSource(source: string): boolean {
  return source.includes(ROUTE_STUB_FILE_MARKER);
}

async function createSocketConnection(
  socketCredentials: SocketCredentials,
  timeoutMs = 1_000
): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect({
      port: socketCredentials.port,
      host: '127.0.0.1',
    });
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error('Socket connection timeout'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    const onConnect = () => {
      socket.setNoDelay(true);
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };

    socket.on('connect', onConnect);
    socket.on('error', onError);
  });
}

async function waitForDeferredBuildComplete(
  socket: Socket,
  authToken: string,
  timeoutMs = ROUTE_STUB_BUILD_WAIT_TIMEOUT_MS
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error('Timed out waiting for deferred route build completion')
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('end', onClose);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Socket closed before deferred route build completed'));
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');

        const message = parseMessage(line, authToken);
        if (message?.type === 'build-complete') {
          cleanup();
          resolve();
          return;
        }
      }
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('end', onClose);
  });
}

async function triggerDeferredRouteStubBuildAndWait(): Promise<void> {
  const socketCredentials = await getSocketCredentials();
  if (!socketCredentials) {
    return;
  }
  const socket = await createSocketConnection(socketCredentials);
  try {
    await writeSocketMessage(
      socket,
      serializeMessage({ type: 'trigger-build' }, socketCredentials.authToken)
    );
    await waitForDeferredBuildComplete(socket, socketCredentials.authToken);
  } finally {
    socket.destroy();
  }
}

async function ensureDeferredRouteStubBuildAndWait(): Promise<void> {
  if (pendingDeferredRouteStubBuildPromise) {
    return pendingDeferredRouteStubBuildPromise;
  }
  const pendingPromise = triggerDeferredRouteStubBuildAndWait();
  pendingDeferredRouteStubBuildPromise = pendingPromise.finally(() => {
    if (pendingDeferredRouteStubBuildPromise === pendingPromise) {
      pendingDeferredRouteStubBuildPromise = null;
    }
  });
  return pendingDeferredRouteStubBuildPromise;
}

async function getBuildersModule(): Promise<
  typeof import('@workflow/builders')
> {
  if (cachedBuildersModule) {
    return cachedBuildersModule;
  }
  // Dynamic import to handle ESM module from CommonJS context
  // biome-ignore lint/security/noGlobalEval: Need to use eval here to avoid TypeScript from transpiling the import statement into `require()`
  cachedBuildersModule = (await eval(
    'import("@workflow/builders")'
  )) as typeof import('@workflow/builders');
  return cachedBuildersModule;
}

async function getDecoratorOptions(
  workingDir: string
): Promise<DecoratorOptionsWithConfigPath> {
  const cached = decoratorOptionsCache.get(workingDir);
  if (cached) {
    return cached;
  }

  const promise = (async (): Promise<DecoratorOptionsWithConfigPath> => {
    const { getDecoratorOptionsForDirectoryWithConfigPath } =
      await getBuildersModule();
    return getDecoratorOptionsForDirectoryWithConfigPath(workingDir);
  })();

  decoratorOptionsCache.set(workingDir, promise);
  return promise;
}

async function detectPatterns(source: string): Promise<WorkflowPatternMatch> {
  const { detectWorkflowPatterns } = await getBuildersModule();
  return detectWorkflowPatterns(source);
}

async function checkGeneratedFile(filePath: string): Promise<boolean> {
  const { isGeneratedWorkflowFile } = await getBuildersModule();
  return isGeneratedWorkflowFile(filePath);
}

async function checkShouldTransform(
  filePath: string,
  patterns: WorkflowPatternMatch
): Promise<boolean> {
  const { shouldTransformFile } = await getBuildersModule();
  return shouldTransformFile(filePath, patterns);
}

async function getModuleSpecifier(
  filePath: string,
  projectRoot: string
): Promise<string | undefined> {
  const { resolveModuleSpecifier } = await getBuildersModule();
  return resolveModuleSpecifier(filePath, projectRoot).moduleSpecifier;
}

async function resolveWorkflowAliasPath(
  filePath: string,
  workingDir: string
): Promise<string | undefined> {
  const { resolveWorkflowAliasRelativePath } = await getBuildersModule();
  return resolveWorkflowAliasRelativePath(filePath, workingDir);
}

async function getRelativeFilenameForSwc(
  filename: string,
  workingDir: string
): Promise<string> {
  const normalizedWorkingDir = workingDir
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
  const normalizedFilepath = filename.replace(/\\/g, '/');

  // Windows fix: Use case-insensitive comparison to work around drive letter casing issues
  const lowerWd = normalizedWorkingDir.toLowerCase();
  const lowerPath = normalizedFilepath.toLowerCase();

  let relativeFilename: string;
  if (lowerPath.startsWith(`${lowerWd}/`)) {
    // File is under working directory - manually calculate relative path
    relativeFilename = normalizedFilepath.substring(
      normalizedWorkingDir.length + 1
    );
  } else if (lowerPath === lowerWd) {
    // File IS the working directory (shouldn't happen)
    relativeFilename = '.';
  } else {
    // Use relative() for files outside working directory
    relativeFilename = relative(workingDir, filename).replace(/\\/g, '/');

    if (relativeFilename.startsWith('../')) {
      const aliasedRelativePath = await resolveWorkflowAliasPath(
        filename,
        workingDir
      );
      if (aliasedRelativePath) {
        relativeFilename = aliasedRelativePath;
      } else {
        relativeFilename = relativeFilename
          .split('/')
          .filter((part) => part !== '..')
          .join('/');
      }
    }
  }

  // Final safety check - ensure we never pass an absolute path to SWC
  if (relativeFilename.includes(':') || relativeFilename.startsWith('/')) {
    // This should rarely happen, but use filename split as last resort
    relativeFilename = normalizedFilepath.split('/').pop() || 'unknown.ts';
  }

  return relativeFilename;
}

function stripDeferredStepSourceMetadataComment(source: string): string {
  const metadataPattern = new RegExp(
    `^\\s*//\\s*${DEFERRED_STEP_SOURCE_METADATA_PREFIX}[A-Za-z0-9+/=]+\\s*\\r?\\n?`
  );
  return source.replace(metadataPattern, '');
}

// This loader applies the "use workflow"/"use step" transform.
// Deferred step-copy files are transformed in step mode; all other files also use step mode.
type WorkflowLoaderContext = {
  resourcePath: string;
  async?: () => (
    error: Error | null,
    content?: string,
    sourceMap?: any
  ) => void;
  addDependency?: (dependency: string) => void;
  addBuildDependency?: (dependency: string) => void;
};

export default function workflowLoader(
  this: WorkflowLoaderContext,
  source: string | Buffer,
  sourceMap: any
): string | Promise<string> | void {
  const callback = this.async?.();
  const run = async (): Promise<{ code: string; map: any }> => {
    const filename = this.resourcePath;
    const normalizedSource = source.toString();
    const workingDir = process.cwd();
    const swcPluginPath = registerTransformDependencies(this);
    const isDeferredStepCopyFile = isDeferredStepCopyFilePath(filename);
    const deferredStepSourceMetadata = isDeferredStepCopyFile
      ? parseDeferredStepSourceMetadata(normalizedSource)
      : null;
    const sourceWithoutDeferredMetadata = isDeferredStepCopyFile
      ? stripDeferredStepSourceMetadataComment(normalizedSource)
      : normalizedSource;
    const deferredSourceMapResult = isDeferredStepCopyFile
      ? parseInlineSourceMapComment(sourceWithoutDeferredMetadata)
      : {
          sourceWithoutMapComment: sourceWithoutDeferredMetadata,
          sourceMap: null,
        };
    const sourceForTransform = deferredSourceMapResult.sourceWithoutMapComment;
    const discoveryFilePath =
      deferredStepSourceMetadata?.absolutePath || filename;

    if (deferredStepSourceMetadata?.absolutePath) {
      // Ensure edits to the original source invalidate deferred step copies.
      registerFileDependency(this, deferredStepSourceMetadata.absolutePath);
    }

    const isGeneratedWorkflowFile = await checkGeneratedFile(filename);
    // Skip generated workflow route files to avoid re-processing them, except
    // deferred route stubs which must wait for generated route output.
    if (isGeneratedWorkflowFile && !isDeferredStepCopyFile) {
      if (
        process.env.WORKFLOW_NEXT_LAZY_DISCOVERY === '1' &&
        isWorkflowRouteStubSource(normalizedSource)
      ) {
        try {
          await ensureDeferredRouteStubBuildAndWait();
          const refreshedSource = await readFile(filename, 'utf8');
          if (!isWorkflowRouteStubSource(refreshedSource)) {
            return { code: refreshedSource, map: sourceMap };
          }
        } catch (error) {
          console.warn(
            `[workflow] Failed waiting for deferred route build for ${filename}, using stub output`,
            error
          );
        }
      }
      return { code: normalizedSource, map: sourceMap };
    }

    // Detect workflow patterns in the source code.
    const patterns = await detectPatterns(sourceForTransform);
    // Always notify discovery tracking, even for `false/false`, so files that
    // previously had workflow/step usage are removed from the tracked sets.
    // Deferred step copy files must report using their original source path so
    // deferred rebuilds can react to source edits outside generated artifacts.
    if (!isDeferredStepCopyFile || deferredStepSourceMetadata?.absolutePath) {
      const hasSerde = patterns.hasSerde;
      const nextPatternState: DiscoveredPatternState = {
        hasWorkflow: patterns.hasUseWorkflow,
        hasStep: patterns.hasUseStep,
        hasSerde,
      };
      const { shouldNotify } = updateDiscoveredPatternState(
        discoveryFilePath,
        nextPatternState
      );
      if (shouldNotify) {
        await notifySocketServer(
          discoveryFilePath,
          nextPatternState.hasWorkflow,
          nextPatternState.hasStep,
          nextPatternState.hasSerde
        );
      }
    }

    if (!isDeferredStepCopyFile) {
      // Check if file needs transformation based on patterns and path
      if (!(await checkShouldTransform(filename, patterns))) {
        return { code: normalizedSource, map: sourceMap };
      }
    }

    const isTypeScript =
      filename.endsWith('.ts') ||
      filename.endsWith('.tsx') ||
      filename.endsWith('.mts') ||
      filename.endsWith('.cts');

    // Calculate relative filename for SWC plugin
    // The SWC plugin uses filename to generate workflowId, so it must be relative
    const relativeFilename =
      deferredStepSourceMetadata?.relativeFilename ||
      (await getRelativeFilenameForSwc(filename, workingDir));

    // Get decorator options from tsconfig (cached per working directory)
    const { options: decoratorOptions, configPath } =
      await getDecoratorOptions(workingDir);
    if (configPath) {
      registerFileDependency(this, configPath);
    }

    // Resolve module specifier for packages (node_modules or workspace packages)
    const moduleSpecifier = await getModuleSpecifier(
      deferredStepSourceMetadata?.absolutePath || filename,
      workingDir
    );
    const mode = 'step';

    // Transform with SWC
    const result = await transform(sourceForTransform, {
      filename: relativeFilename,
      jsc: {
        parser: {
          ...(isTypeScript
            ? {
                syntax: 'typescript',
                tsx: filename.endsWith('.tsx'),
                decorators: decoratorOptions.decorators,
              }
            : {
                syntax: 'ecmascript',
                jsx: filename.endsWith('.jsx'),
                decorators: decoratorOptions.decorators,
              }),
        },
        target: 'es2022',
        experimental: {
          plugins: [[swcPluginPath, { mode, moduleSpecifier }]],
        },
        transform: {
          react: {
            runtime: 'preserve',
          },
          legacyDecorator: decoratorOptions.legacyDecorator,
          decoratorMetadata: decoratorOptions.decoratorMetadata,
        },
      },
      minify: false,
      inputSourceMap: isDeferredStepCopyFile
        ? deferredSourceMapResult.sourceMap || sourceMap
        : sourceMap,
      sourceMaps: true,
      inlineSourcesContent: true,
    });

    let transformedMap = sourceMap;
    if (typeof result.map === 'string') {
      try {
        transformedMap = JSON.parse(result.map);
      } catch {
        transformedMap = result.map;
      }
    } else if (result.map) {
      transformedMap = result.map;
    }

    return { code: result.code, map: transformedMap };
  };

  if (!callback) {
    return run().then((result) => result.code);
  }

  void run()
    .then((result) => callback(null, result.code, result.map))
    .catch((error: unknown) => {
      callback(error instanceof Error ? error : new Error(String(error)));
    });
}
