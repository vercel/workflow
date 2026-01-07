import type {
  HealthCheckEndpoint,
  HealthCheckOptions,
  HealthCheckResult,
  World,
} from '@workflow/world';
import { HEALTH_CHECK_STREAM_PREFIX } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { createQueue } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';
import type { APIConfig } from './utils.js';

export { createQueue } from './queue.js';
export { createStorage } from './storage.js';
export { createStreamer } from './streamer.js';
export type { APIConfig } from './utils.js';

/** Default timeout for health checks in milliseconds */
const DEFAULT_HEALTH_CHECK_TIMEOUT = 30_000;

export function createVercelWorld(config?: APIConfig): World {
  const queueFns = createQueue(config);
  const streamer = createStreamer(config);
  const generateId = monotonicFactory();

  const healthCheck = async (
    endpoint: HealthCheckEndpoint,
    options?: HealthCheckOptions
  ): Promise<HealthCheckResult> => {
    const timeout = options?.timeout ?? DEFAULT_HEALTH_CHECK_TIMEOUT;
    const correlationId = `hc_${generateId()}`;
    const streamName = `${HEALTH_CHECK_STREAM_PREFIX}${correlationId}`;

    // Determine which queue to use based on endpoint
    const queueName =
      endpoint === 'workflow'
        ? '__wkf_workflow___health_check__'
        : '__wkf_step___health_check__';

    try {
      // Send the health check message through the queue
      await queueFns.queue(queueName as `__wkf_workflow_${string}`, {
        __healthCheck: true,
        correlationId,
      });

      // Wait for the response with timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Health check timed out after ${timeout}ms`));
        }, timeout);
      });

      const readStreamResponse = async (): Promise<HealthCheckResult> => {
        // Read from the stream - the handler will write to this when it receives the health check
        const stream = await streamer.readFromStream(streamName);
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];

        let done = false;
        while (!done) {
          const result = await reader.read();
          done = result.done;
          if (result.value) chunks.push(result.value);
        }

        // Parse the response
        const responseText = new TextDecoder().decode(
          Buffer.concat(chunks.map((c) => Buffer.from(c)))
        );
        const response = JSON.parse(responseText);

        return {
          healthy: response.healthy === true,
        };
      };

      return await Promise.race([readStreamResponse(), timeoutPromise]);
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return {
    ...queueFns,
    ...createStorage(config),
    ...streamer,
    healthCheck,
  };
}
