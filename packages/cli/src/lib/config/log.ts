import boxen from 'boxen';
import chalk from 'chalk';

export const LOGGING_CONFIG = {
  JSON_MODE: false,
  VERBOSE_MODE: false,
};

export const setJsonMode = (value: boolean) => {
  LOGGING_CONFIG.JSON_MODE = Boolean(value);
};

export const setVerboseMode = (value: boolean) => {
  LOGGING_CONFIG.VERBOSE_MODE = Boolean(value);
};

/**
 * This Logger should be unified with `core/src/logger.ts`. The main difference
 * is that the CLI logger has internal handling on JSON/VERBOSE modes, but
 * does not implement per-module logging and debug levels.
 *
 * There are four modes of operation:
 * - Regular (both JSON and VERBOSE modes are off)
 * - JSON mode (JSON mode is on, VERBOSE mode is off)
 * - verbose mode (JSON mode is off, VERBOSE mode is on)
 * - verbose JSON mode (JSON and VERBOSE modes are on)
 *
 * Generally, we want to hide debug logs unless verbose mode is on,
 * and during JSON mode, we want to ensure no logs end up in stdout,
 * because we assume the user might be piping the output to a JSON parser.
 * However, during verbose JSON mode, we want to keep debug information
 * without breaking the JSON output, so we redirect all logs to stderr.
 */
class Logger {
  constructor() {}

  shouldLogToStderr = () => {
    return LOGGING_CONFIG.JSON_MODE;
  };

  shouldSkipDebugLogs = () => {
    return !LOGGING_CONFIG.VERBOSE_MODE;
  };

  private logPlain = (...args: any[]) => {
    if (this.shouldLogToStderr()) {
      console.error(...args);
      return;
    }
    console.log(...args);
  };

  private logDebug = (...args: any[]) => {
    if (this.shouldLogToStderr()) {
      console.error(...args);
      return;
    }
    if (this.shouldSkipDebugLogs()) {
      return;
    }
    console.debug(...args);
  };

  private logWarn = (...args: any[]) => {
    if (this.shouldLogToStderr()) {
      console.error(...args);
      return;
    }
    console.warn(...args);
  };

  private logError = (...args: any[]) => {
    console.error(...args);
  };

  log = (...args: any[]) => {
    this.logPlain(...args);
  };

  info = (...args: any[]) => {
    this.logPlain(chalk.white(`[Info]`, ...args));
  };

  success = (...args: any[]) => {
    this.logPlain(chalk.green(`[Success]`, ...args));
  };

  debug = (...args: any[]) => {
    this.logDebug(chalk.gray(`[Debug]`, ...args));
  };

  warn = (...args: any[]) => {
    this.logWarn(chalk.yellow(`[Warn]`, ...args));
  };

  error = (...args: any[]) => {
    this.logError(chalk.red(`[Error]`, ...args));
  };

  showBox = (
    color: 'yellow' | 'green' | 'white',
    ...lines: (string | undefined)[]
  ) => {
    const borderColor =
      color === 'yellow' ? 'yellow' : color === 'green' ? 'green' : 'white';
    const content = lines.filter((line) => line !== undefined).join('\n');
    const box = boxen(content, {
      padding: 1,
      borderColor: borderColor as any,
      textAlignment: 'center',
    });
    this.logPlain(box);
  };
}

export const logger = new Logger();
