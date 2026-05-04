import debug from 'debug';
import { composeLogLine } from './log-format.js';
import { getActiveSpan } from './telemetry.js';

type LogMetadata = Record<string, unknown>;

type LogFn = (message: string, metadata?: LogMetadata) => void;

export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  /**
   * Returns a child logger that merges the given metadata into every call.
   * Useful for attaching stable context (e.g. `workflowRunId`, `workflowName`,
   * `stepId`) so callers don't have to repeat it on every log.
   *
   * Call-site metadata wins on conflict, so children can still override.
   */
  child: (metadata: LogMetadata) => Logger;
  /**
   * Convenience child logger for a workflow run. Equivalent to
   * `logger.child({ workflowRunId, workflowName })`, but centralized so all
   * runtime code structures run metadata consistently.
   */
  forRun: (
    workflowRunId: string,
    workflowName?: string,
    extra?: LogMetadata
  ) => Logger;
}

function createLogger(namespace: string): Logger {
  const baseDebug = debug(`workflow:${namespace}`);

  const build = (parentMetadata: LogMetadata): Logger => {
    const logger = (level: string): LogFn => {
      const levelDebug = baseDebug.extend(level);

      return (message, metadata) => {
        const hasParent = Object.keys(parentMetadata).length > 0;
        const hasCallSite = metadata && Object.keys(metadata).length > 0;
        const merged =
          hasParent || hasCallSite
            ? { ...parentMetadata, ...(metadata ?? {}) }
            : undefined;

        // Always output error/warn to console so users see critical issues.
        // debug/info only output when DEBUG env var is set.
        //
        // Compose the framing + structured fields + (trimmed) stack into a
        // single string so the runtime's `console.error` / `util.inspect`
        // doesn't quote-escape multi-line stacks or paragraph hints inside
        // a JSON-y object dump. The framing line stays at the top with the
        // structured fields right under it; the stack body — with framework
        // internal frames collapsed — sits at the bottom. See log-format.ts.
        if (level === 'error' || level === 'warn') {
          const out = level === 'error' ? console.error : console.warn;
          out(composeLogLine('[workflow-sdk]', message, merged));
        }

        // Also log to debug library for verbose output when DEBUG is enabled
        levelDebug(message, merged);

        if (levelDebug.enabled) {
          getActiveSpan()
            .then((span) => {
              span?.addEvent(`${level}.${namespace}`, { message, ...merged });
            })
            .catch(() => {
              // Silently ignore telemetry errors
            });
        }
      };
    };

    return {
      debug: logger('debug'),
      info: logger('info'),
      warn: logger('warn'),
      error: logger('error'),
      child: (metadata) => build({ ...parentMetadata, ...metadata }),
      forRun: (workflowRunId, workflowName, extra) =>
        build({
          ...parentMetadata,
          workflowRunId,
          ...(workflowName !== undefined ? { workflowName } : {}),
          ...(extra ?? {}),
        }),
    };
  };

  return build({});
}

export const stepLogger = createLogger('step');
export const runtimeLogger = createLogger('runtime');
export const webhookLogger = createLogger('webhook');
export const eventsLogger = createLogger('events');
export const adapterLogger = createLogger('adapter');
