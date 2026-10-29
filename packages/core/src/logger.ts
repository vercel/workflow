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

type LoggerOptions = {
  debugNamespace?: string;
};

/**
 * Lightweight `DEBUG=` pattern matcher. Replaces the `debug` package, which
 * was previously a static dependency of this module: that import path
 * pulled `debug/src/node` and its dynamic `require('tty')` into the
 * generated Next.js webpack flow route, breaking the V2 combined-bundle
 * build with `Dynamic require of "tty" is not supported`. Keeping this
 * module free of `debug` is a prerequisite for V2 webpack builds.
 */
function matchesDebugNamespace(
  namespace: string,
  patternList: unknown
): boolean {
  // Bundlers can replace `process.env.DEBUG` with a non-string constant.
  // Nitro's dev build, for one, defines it as its own boolean `debug` option.
  if (typeof patternList !== 'string' || !patternList) {
    return false;
  }

  let enabled = false;
  for (const rawPattern of patternList.split(',')) {
    const pattern = rawPattern.trim();
    if (!pattern) {
      continue;
    }

    const isNegated = pattern.startsWith('-');
    const candidate = isNegated ? pattern.slice(1) : pattern;
    const regex = new RegExp(
      `^${candidate.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*')}$`
    );

    if (regex.test(namespace)) {
      enabled = !isNegated;
    }
  }

  return enabled;
}

/** A call's metadata over its logger's, or `undefined` when both are empty. */
function mergeMetadata(
  parent: LogMetadata,
  metadata: LogMetadata | undefined
): LogMetadata | undefined {
  const hasParent = Object.keys(parent).length > 0;
  const hasCallSite = metadata && Object.keys(metadata).length > 0;
  return hasParent || hasCallSite
    ? { ...parent, ...(metadata ?? {}) }
    : undefined;
}

/** Prints an enabled debug or info line and records it on the active span. */
function emitDebug(
  debugNamespace: string,
  spanEventName: string,
  message: string,
  merged: LogMetadata | undefined
): void {
  console.debug(`[${debugNamespace}] ${message}`, merged ?? '');
  getActiveSpan()
    .then((span) => {
      span?.addEvent(spanEventName, { message, ...merged });
    })
    .catch(() => {
      // Silently ignore telemetry errors
    });
}

/**
 * One level's log function. Disabled debug and info logging sits on hot
 * paths (once per event a replay walks), so it returns before building
 * anything.
 */
function createLogFn(
  namespace: string,
  level: string,
  debugNamespace: string,
  parentMetadata: LogMetadata
): LogFn {
  const alwaysPrints = level === 'error' || level === 'warn';
  // The `DEBUG` value `matchedEnabled` was computed for. `DEBUG` is read
  // on every call, so a changed value takes effect on the next log, but
  // its patterns are matched once per value.
  let matchedDebug: unknown;
  let matchedEnabled = false;
  const isDebugEnabled = (): boolean => {
    const raw = process.env.DEBUG;
    if (!raw) return false;
    if (raw !== matchedDebug) {
      matchedDebug = raw;
      matchedEnabled = matchesDebugNamespace(debugNamespace, raw);
    }
    return matchedEnabled;
  };

  return (message, metadata) => {
    const debugEnabled = isDebugEnabled();
    if (!alwaysPrints && !debugEnabled) return;

    const merged = mergeMetadata(parentMetadata, metadata);

    // Always output error/warn to console so users see critical issues.
    // debug/info only output when DEBUG env var matches the namespace.
    //
    // Compose the framing + structured fields + (trimmed) stack into a
    // single string so the runtime's `console.error` / `util.inspect`
    // doesn't quote-escape multi-line stacks or paragraph hints inside
    // a JSON-y object dump. The framing line stays at the top with the
    // structured fields right under it; the stack body (with framework
    // internal frames collapsed) sits at the bottom. See log-format.ts.
    if (alwaysPrints) {
      (level === 'error' ? console.error : console.warn)(
        composeLogLine('[workflow-sdk]', message, merged)
      );
    }

    if (debugEnabled) {
      emitDebug(debugNamespace, `${level}.${namespace}`, message, merged);
    }
  };
}

function createLogger(namespace: string, options: LoggerOptions = {}): Logger {
  const build = (parentMetadata: LogMetadata): Logger => {
    const getDebugNamespace = (level: string) =>
      options.debugNamespace ?? `workflow:${namespace}:${level}`;

    const logger = (level: string): LogFn =>
      createLogFn(namespace, level, getDebugNamespace(level), parentMetadata);

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
export const buildLogger = createLogger('build', {
  debugNamespace: 'workflow:build',
});
