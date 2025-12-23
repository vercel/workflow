import { readFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { relative } from 'node:path';
import { transform } from '@swc/core';
import { useStepPattern, useWorkflowPattern } from '@workflow/builders';
import {
  parseMessage,
  type SocketMessage,
  serializeMessage,
} from './socket-server';

// Stub content written by builder to inner.js files
const STUB_CONTENT = 'WORKFLOW_INNER_STUB_FILE';

// Cache for socket connection to avoid reconnecting on every file
let socketClientPromise: Promise<Socket | null> | null = null;

async function getSocketClient() {
  if (!socketClientPromise) {
    socketClientPromise = (async () => {
      const socketPort = process.env.WORKFLOW_SOCKET_PORT;
      if (!socketPort) {
        throw new Error(
          `Invariant: no socket port provided for workflow loader`
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
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error('Socket connection timeout'));
        }, 1000);

        socket.on('connect', () => {
          socket.setNoDelay(true);
          clearTimeout(timeout);
          resolve();
        });

        socket.on('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      return socket;
    })();
  }

  return socketClientPromise;
}

async function notifySocketServer(
  filename: string,
  hasWorkflow: boolean,
  hasStep: boolean
) {
  const socket = await getSocketClient();
  if (!socket) {
    throw new Error(`Invariant: missing workflow socket connection`);
  }

  const authToken = process.env.WORKFLOW_SOCKET_AUTH;
  if (!authToken) {
    throw new Error(
      `Invariant: no socket auth token provided for workflow loader`
    );
  }

  // Send authenticated message with workflow and step information
  const message: SocketMessage = {
    type: 'file-discovered',
    filePath: filename,
    hasWorkflow,
    hasStep,
  };
  socket.write(serializeMessage(message, authToken));
}

async function waitForBuildComplete(): Promise<void> {
  const socket = await getSocketClient();

  return new Promise((resolve, reject) => {
    if (!socket) {
      reject(new Error('Socket not available'));
      return;
    }

    let buffer = '';
    let timeout: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      socket.off('close', onClose);
    };

    const settle = (callback: () => void) => {
      if (!settled) {
        settled = true;
        cleanup();
        callback();
      }
    };

    const onData = (data: Buffer) => {
      buffer += data.toString();

      const authToken = process.env.WORKFLOW_SOCKET_AUTH;
      if (!authToken) {
        settle(() => reject(new Error('No socket auth token available')));
        return;
      }

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');

        const message = parseMessage(line, authToken);
        if (message && message.type === 'build-complete') {
          settle(() => resolve());
        }
      }
    };

    const onError = (err: Error) => {
      settle(() => reject(new Error(`Socket error: ${err.message}`)));
    };

    const onEnd = () => {
      settle(() =>
        reject(
          new Error(
            'Socket ended unexpectedly before build-complete message received'
          )
        )
      );
    };

    const onClose = () => {
      settle(() =>
        reject(
          new Error(
            'Socket closed unexpectedly before build-complete message received'
          )
        )
      );
    };

    // Set timeout to prevent indefinite hanging
    timeout = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            'Timeout waiting for build-complete message (60 seconds elapsed)'
          )
        )
      );
    }, 60000); // 60 second timeout

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
    socket.on('close', onClose);
  });
}

// This loader applies the "use workflow"/"use step"
// client transformation
export default async function workflowLoader(
  this: {
    resourcePath: string;
  },
  source: string | Buffer,
  sourceMap: any
): Promise<string> {
  const filename = this.resourcePath;
  const normalizedSource = source.toString();

  // Normalize path separators for cross-platform compatibility
  const normalizedFilename = filename.replace(/\\/g, '/');

  // Check if this is a .well-known workflow inner.js file with stub content
  const isWellKnownInnerFile =
    normalizedFilename.includes('.well-known/workflow/v1/') &&
    (normalizedFilename.includes('/flow/inner.js') ||
      normalizedFilename.includes('/step/inner.js') ||
      normalizedFilename.includes('/webhook/[token]/inner.js'));

  if (
    isWellKnownInnerFile &&
    normalizedSource.trim().startsWith(STUB_CONTENT)
  ) {
    // Wait for build to complete
    await waitForBuildComplete();

    // Read the actual generated file content
    const actualContent = await readFile(
      filename.replace(/inner\.js$/, 'route.js'),
      'utf-8'
    );
    return actualContent;
  }

  // Check for workflow and step directives
  const hasWorkflow = useWorkflowPattern.test(normalizedSource);
  const hasStep = useStepPattern.test(normalizedSource);

  // Send message to socket server if workflow or step detected
  await notifySocketServer(filename, hasWorkflow, hasStep);

  // only apply the transform if file needs it
  if (!hasWorkflow && !hasStep) {
    return normalizedSource;
  }

  const isTypeScript =
    filename.endsWith('.ts') ||
    filename.endsWith('.tsx') ||
    filename.endsWith('.mts') ||
    filename.endsWith('.cts');

  // Calculate relative filename for SWC plugin
  // The SWC plugin uses filename to generate workflowId, so it must be relative
  const workingDir = process.cwd();
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
      relativeFilename = relativeFilename
        .split('/')
        .filter((part) => part !== '..')
        .join('/');
    }
  }

  // Final safety check - ensure we never pass an absolute path to SWC
  if (relativeFilename.includes(':') || relativeFilename.startsWith('/')) {
    // This should rarely happen, but use filename split as last resort
    relativeFilename = normalizedFilepath.split('/').pop() || 'unknown.ts';
  }

  // Transform with SWC
  const result = await transform(normalizedSource, {
    filename: relativeFilename,
    jsc: {
      parser: {
        ...(isTypeScript
          ? {
              syntax: 'typescript',
              tsx: filename.endsWith('.tsx'),
            }
          : {
              syntax: 'ecmascript',
              jsx: filename.endsWith('.jsx'),
            }),
      },
      target: 'es2022',
      experimental: {
        plugins: [
          [require.resolve('@workflow/swc-plugin'), { mode: 'client' }],
        ],
      },
      transform: {
        react: {
          runtime: 'preserve',
        },
      },
    },
    minify: false,
    inputSourceMap: sourceMap,
    sourceMaps: true,
    inlineSourcesContent: true,
  });

  return result.code;
}
