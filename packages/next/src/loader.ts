import { connect, type Socket } from 'node:net';
import { relative } from 'node:path';
import { transform } from '@swc/core';
import { type SocketMessage, serializeMessage } from './socket-server.js';
import {
  DEFERRED_STEP_SOURCE_METADATA_PREFIX,
  isDeferredStepCopyFilePath,
  parseInlineSourceMapComment,
  parseDeferredStepSourceMetadata,
} from './step-copy-utils.js';

type DecoratorOptions = import('@workflow/builders').DecoratorOptions;
type WorkflowPatternMatch = import('@workflow/builders').WorkflowPatternMatch;

// Cache decorator options per working directory to avoid reading tsconfig for every file
const decoratorOptionsCache = new Map<string, Promise<DecoratorOptions>>();
// Cache for shared utilities from @workflow/builders (ESM module loaded dynamically in CommonJS context)
let cachedBuildersModule: typeof import('@workflow/builders') | null = null;

// Cache socket connection to avoid reconnecting on every file.
let socketClientPromise: Promise<Socket | null> | null = null;
let socketClient: Socket | null = null;

function resetSocketClient(cachedSocket?: Socket): void {
  if (cachedSocket && socketClient && socketClient !== cachedSocket) {
    return;
  }

  socketClientPromise = null;
  socketClient = null;
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

function shouldUseSocketDiscovery(): boolean {
  return Boolean(
    process.env.WORKFLOW_SOCKET_PORT && process.env.WORKFLOW_SOCKET_AUTH
  );
}

async function getSocketClient(): Promise<Socket | null> {
  if (!shouldUseSocketDiscovery()) {
    return null;
  }

  if (socketClient?.destroyed) {
    resetSocketClient(socketClient);
  }

  if (!socketClientPromise) {
    socketClientPromise = (async () => {
      try {
        const socketPort = process.env.WORKFLOW_SOCKET_PORT;
        if (!socketPort) {
          throw new Error(
            'Invariant: no socket port provided for workflow loader'
          );
        }

        const port = Number.parseInt(socketPort, 10);
        if (Number.isNaN(port)) {
          throw new Error(
            `Invariant: invalid socket port provided: ${socketPort}`
          );
        }

        const socket = connect({ port, host: '127.0.0.1' });

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
  if (!shouldUseSocketDiscovery()) {
    return;
  }

  const socket = await getSocketClient();
  if (!socket) {
    throw new Error('Invariant: missing workflow socket connection');
  }

  const authToken = process.env.WORKFLOW_SOCKET_AUTH;
  if (!authToken) {
    throw new Error(
      'Invariant: no socket auth token provided for workflow loader'
    );
  }

  const message: SocketMessage = {
    type: 'file-discovered',
    filePath: filename,
    hasWorkflow,
    hasStep,
    hasSerde,
  };
  const serializedMessage = serializeMessage(message, authToken);

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
): Promise<DecoratorOptions> {
  const cached = decoratorOptionsCache.get(workingDir);
  if (cached) {
    return cached;
  }

  const promise = (async (): Promise<DecoratorOptions> => {
    const { getDecoratorOptionsForDirectory } = await getBuildersModule();
    return getDecoratorOptionsForDirectory(workingDir);
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

async function checkSdkFile(filePath: string): Promise<boolean> {
  const { isWorkflowSdkFile } = await getBuildersModule();
  return isWorkflowSdkFile(filePath);
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
// Deferred step-copy files are transformed in step mode; all other files use client mode.
export default function workflowLoader(
  this: {
    resourcePath: string;
    async?: () => (
      error: Error | null,
      content?: string,
      sourceMap?: any
    ) => void;
  },
  source: string | Buffer,
  sourceMap: any
): string | Promise<string> | void {
  const callback = this.async?.();
  const run = async (): Promise<{ code: string; map: any }> => {
    const filename = this.resourcePath;
    const normalizedSource = source.toString();
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

    // Skip generated workflow route files to avoid re-processing them
    if ((await checkGeneratedFile(filename)) && !isDeferredStepCopyFile) {
      return { code: normalizedSource, map: sourceMap };
    }

    // Detect workflow patterns in the source code
    const patterns = await detectPatterns(normalizedSource);
    // Always notify discovery tracking, even for `false/false`, so files that
    // previously had workflow/step usage are removed from the tracked sets.
    if (!isDeferredStepCopyFile) {
      await notifySocketServer(
        filename,
        patterns.hasUseWorkflow,
        patterns.hasUseStep,
        patterns.hasSerde
      );

      // For @workflow SDK packages, only transform files with actual directives,
      // not files that just match serde patterns (which are internal SDK implementation files)
      const isSdkFile = await checkSdkFile(filename);
      if (isSdkFile && !patterns.hasDirective) {
        return { code: normalizedSource, map: sourceMap };
      }

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
    const workingDir = process.cwd();
    const relativeFilename =
      deferredStepSourceMetadata?.relativeFilename ||
      (await getRelativeFilenameForSwc(filename, workingDir));

    // Get decorator options from tsconfig (cached per working directory)
    const decoratorOptions = await getDecoratorOptions(workingDir);

    // Resolve module specifier for packages (node_modules or workspace packages)
    const moduleSpecifier = await getModuleSpecifier(
      deferredStepSourceMetadata?.absolutePath || filename,
      workingDir
    );
    const mode = isDeferredStepCopyFile ? 'step' : 'client';

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
          plugins: [
            [
              require.resolve('@workflow/swc-plugin'),
              { mode, moduleSpecifier },
            ],
          ],
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
