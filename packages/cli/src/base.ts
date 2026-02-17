import { Command } from '@oclif/core';
import { getWorld } from '@workflow/core/runtime';

export abstract class BaseCommand extends Command {
  static enableJsonFlag = true;

  /**
   * Called by oclif after `run()` completes (or throws).
   * Closes the cached World instance so the process can exit cleanly
   * without relying on `process.exit()`.
   */
  async finally(err: Error | undefined): Promise<void> {
    try {
      const world = getWorld();
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
    process.exit(err ? 1 : 0);
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
