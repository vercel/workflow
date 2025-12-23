import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

/**
 * Magic preamble that must prefix all messages to authenticate them as workflow messages.
 * This prevents accidental processing of messages from port scanners or other local processes.
 */
const MESSAGE_PREAMBLE = 'WF:';

/**
 * Generate a random authentication token for this server session.
 * Clients must include this token in all messages.
 */
function generateAuthToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Message types that can be sent between loader and builder
 */
export type SocketMessage =
  | {
      type: 'file-discovered';
      filePath: string;
      hasWorkflow: boolean;
      hasStep: boolean;
    }
  | { type: 'trigger-build' }
  | { type: 'build-complete' };

/**
 * Configuration for the socket server
 */
export interface SocketServerConfig {
  isDevServer: boolean;
  onFileDiscovered: (
    filePath: string,
    hasWorkflow: boolean,
    hasStep: boolean
  ) => void;
  onTriggerBuild: () => void;
}

/**
 * Interface for the socket IO instance returned by createSocketServer
 */
export interface SocketIO {
  emit(event: 'build-complete'): void;
  getAuthToken(): string;
}

/**
 * Serialize a message with authentication preamble
 */
export function serializeMessage(
  message: SocketMessage,
  authToken: string
): string {
  return `${MESSAGE_PREAMBLE}${authToken}:${JSON.stringify(message)}\n`;
}

/**
 * Parse and authenticate a message from the socket
 * Returns the parsed message if valid, null otherwise
 */
export function parseMessage(
  line: string,
  authToken: string
): SocketMessage | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  // Check for preamble
  if (!trimmed.startsWith(MESSAGE_PREAMBLE)) {
    console.warn('Received message without valid preamble, ignoring');
    return null;
  }

  // Extract auth token and payload
  const withoutPreamble = trimmed.slice(MESSAGE_PREAMBLE.length);
  const colonIndex = withoutPreamble.indexOf(':');
  if (colonIndex === -1) {
    console.warn('Received message without auth token separator, ignoring');
    return null;
  }

  const messageToken = withoutPreamble.slice(0, colonIndex);
  const payload = withoutPreamble.slice(colonIndex + 1);

  // Verify auth token
  if (messageToken !== authToken) {
    console.warn('Received message with invalid auth token, ignoring');
    return null;
  }

  // Parse JSON payload
  try {
    return JSON.parse(payload) as SocketMessage;
  } catch (error) {
    console.error('Failed to parse socket message JSON:', error);
    return null;
  }
}

/**
 * Create a TCP socket server for loader<->builder communication.
 * Returns a SocketIO interface for broadcasting messages and the auth token.
 *
 * SECURITY: Server listens on 127.0.0.1 (localhost only) and uses
 * message authentication to prevent processing of unauthorized messages.
 */
export async function createSocketServer(
  config: SocketServerConfig
): Promise<SocketIO> {
  const authToken = generateAuthToken();
  const clients = new Set<Socket>();
  let buildTriggered = false;

  const server: Server = createServer((socket: Socket) => {
    socket.setNoDelay(true);
    clients.add(socket);

    // Send build-complete if build already finished (production mode)
    if (buildTriggered && !config.isDevServer) {
      socket.write(serializeMessage({ type: 'build-complete' }, authToken));
    }

    let buffer = '';

    socket.on('data', (data: Buffer) => {
      buffer += data.toString();

      // Process complete messages (newline-delimited)
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');

        const message = parseMessage(line, authToken);
        if (!message) {
          continue;
        }

        if (message.type === 'file-discovered') {
          config.onFileDiscovered(
            message.filePath,
            message.hasWorkflow,
            message.hasStep
          );
        } else if (message.type === 'trigger-build') {
          config.onTriggerBuild();
        }
      }
    });

    socket.on('end', () => {
      clients.delete(socket);
    });

    socket.on('error', (err: Error) => {
      console.error('Socket error:', err);
      clients.delete(socket);
    });
  });

  // Listen on random available port (localhost only)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        process.env.WORKFLOW_SOCKET_PORT = String(address.port);
        process.env.WORKFLOW_SOCKET_AUTH = authToken;
      }
      resolve();
    });
  });

  return {
    emit: (_event: 'build-complete') => {
      buildTriggered = true;
      const message = serializeMessage({ type: 'build-complete' }, authToken);
      for (const client of clients) {
        client.write(message);
      }
    },
    getAuthToken: () => authToken,
  };
}
