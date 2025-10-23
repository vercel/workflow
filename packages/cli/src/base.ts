import { Command } from '@oclif/core';

export abstract class BaseCommand extends Command {
  static enableJsonFlag = true;

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
