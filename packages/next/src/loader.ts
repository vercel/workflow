import { readFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { relative } from 'node:path';
import { transform } from '@swc/core';
import { useStepPattern, useWorkflowPattern } from '@workflow/builders';

// Stub content written by builder to inner.js files
const STUB_CONTENT = 'WORKFLOW_INNER_STUB_FILE';

// Cache for socket connection to avoid reconnecting on every file
let socketClientPromise: Promise<Socket | null> | null = null;

async function getSocketClient() {
  if (!socketClientPromise) {
    socketClientPromise = (async () => {
      const socketPath = process.env.WORKFLOW_SOCKET_PATH;
      if (!socketPath) {
        throw new Error(
          `Invariant: no socket path provided for workflow loader`
        );
      }

      const socket = connect(socketPath);

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error('Socket connection timeout'));
        }, 1000);

        socket.on('connect', () => {
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
  try {
    const socket = await getSocketClient();
    if (!socket) {
      return;
    }

    // Send single message with both workflow and step information
    const message =
      JSON.stringify({
        type: 'file-discovered',
        filePath: filename,
        hasWorkflow,
        hasStep,
      }) + '\n';
    socket.write(message);
  } catch {
    // Silently fail - socket server might not be available yet
  }
}

async function waitForBuildComplete(): Promise<void> {
  const socket = await getSocketClient();

  return new Promise((resolve, reject) => {
    if (!socket) {
      reject(new Error('Socket not available'));
      return;
    }

    let buffer = '';
    const timeout = setTimeout(() => {
      socket.off('data', onData);
      reject(new Error('Build complete timeout'));
    }, 60000); // 60 second timeout

    const onData = (data: Buffer) => {
      buffer += data.toString();

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');

        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            if (message.type === 'build-complete') {
              clearTimeout(timeout);
              socket.off('data', onData);
              resolve();
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    };

    socket.on('data', onData);

    // Send trigger-build message
    const message = JSON.stringify({ type: 'trigger-build' }) + '\n';
    socket.write(message);
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
      normalizedFilename.includes('/webhook/inner.js') ||
      normalizedFilename.includes('/webhook/[token]/inner.js'));

  if (
    isWellKnownInnerFile &&
    normalizedSource.trim().startsWith(STUB_CONTENT)
  ) {
    // Wait for build to complete
    await waitForBuildComplete();

    // Read the actual generated file content
    const actualContent = await readFile(
      filename.replace(/inner\.js/, 'route.js'),
      'utf-8'
    );
    return actualContent;
  }

  // Check for workflow and step directives
  const hasWorkflow = useWorkflowPattern.test(normalizedSource);
  normalizedSource;
  const hasStep = useStepPattern.test(normalizedSource);

  // only apply the transform if file needs it
  if (!hasWorkflow && !hasStep) {
    return normalizedSource;
  }

  // Send message to socket server if workflow or step detected
  await notifySocketServer(filename, hasWorkflow, hasStep);

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
  if (lowerPath.startsWith(lowerWd + '/')) {
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
