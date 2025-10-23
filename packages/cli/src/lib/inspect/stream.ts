import { logger } from '../config/log.js';
import type { InspectCLIOptions } from '../config/types.js';

/**
 * This function will read from the stream and write the output to the console.
 * If the stream is not closed, this function will block until the stream is closed.
 */
export const streamToConsole = async (
  stream: ReadableStream,
  id: string,
  opts: InspectCLIOptions
) => {
  const reader = stream.getReader();
  // Keep the Node.js event loop alive while we await stream closure.
  // Pending Promises alone do not keep the process alive when using oclif.
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      // Skip empty chunks - this prevents crashes when value is undefined/null
      // but done is false (stream waiting for more data)
      if (!value || value.byteLength === 0) {
        continue;
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(value)}\n`);
      } else {
        logger.log(value);
      }
    }
  } catch (err) {
    console.error(`Failed to read stream with ID ${id}:`, err);
    if (opts.json) {
      const json = JSON.stringify({
        error: `Failed to read stream with ID ${id}`,
        details: String(err),
      });
      process.stderr.write(`${json}\n`);
    }
  } finally {
    clearInterval(keepAlive);
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors during cleanup
    }
  }
};
