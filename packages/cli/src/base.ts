import { Command } from '@oclif/core';
import { getWorld } from '@workflow/core/runtime';

async function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  if (
    !stream.writable ||
    stream.destroyed ||
    stream.closed ||
    stream.writableEnded ||
    stream.writableFinished
  ) {
    return;
  }

  await new Promise<void>((resolve) => {
    const onError = () => resolve();
    stream.once('error', onError);
    try {
      stream.write('', () => {
        stream.off('error', onError);
        resolve();
      });
    } catch {
      stream.off('error', onError);
      resolve();
    }
  });
}

export abstract class BaseCommand extends Command {
  static enableJsonFlag = true;

  /**
   * Called by oclif after `run()` completes (or throws).
   * Closes the cached World instance so the process can exit cleanly
   * without relying on `process.exit()`.
   */
  async finally(err: Error | undefined): Promise<void> {
    try {
      const world = await getWorld();
      await world.close?.();
    } catch (closeErr) {
      this.warn(
        `Failed to close world: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`
      );
    }
    await super.finally(err);
    // Force exit. World.close() cleaned up database connections and HTTP
    // agents, but third-party libraries (oclif update checker, postgres.js)
    // may leave timers or sockets that prevent the event loop from draining.
    // This is safe because all business logic and cleanup has completed.
    await Promise.all([
      flushStream(process.stdout),
      flushStream(process.stderr),
    ]);
    process.exit(err ? 1 : (process.exitCode ?? 0));
  }

  protected logInfo(message: string): void {
    this.log(message);
  }

  protected logWarn(message: string): void {
    this.warn(message);
  }

  protected logError(message: string): void {
    this.error(message);
  }
}
