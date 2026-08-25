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
   * Whether `debug` calls currently produce output. Hot paths that log per
   * replayed event use this to skip building call-site metadata entirely:
   * the disabled-logging fast path inside the log functions is allocation
   * free, but the metadata object literal at the call site is not.
   */
  debugEnabled: () => boolean;
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
  patternList: string | undefined
): boolean {
  if (!patternList) {
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

function createLogger(namespace: string, options: LoggerOptions = {}): Logger {
  const build = (parentMetadata: LogMetadata): Logger => {
    const getDebugNamespace = (level: string) =>
      options.debugNamespace ?? `workflow:${namespace}:${level}`;

    const logger = (level: string) => {
      const debugNamespace = getDebugNamespace(level);

      // Memoize the DEBUG pattern match keyed on the pattern string itself.
      // The disabled path runs O(registered steps × replayed events) inside
      // the replay hot loop; splitting the pattern list and building RegExps
      // per call measured ~12% of raw app CPU at fanout(50). Keying on the
      // string preserves runtime toggling (tests stub DEBUG mid-process).
      let cachedPattern: string | undefined;
      let cachedPatternValid = false;
      let cachedEnabled = false;
      const isEnabled = () => {
        const pattern = process.env.DEBUG;
        if (!cachedPatternValid || pattern !== cachedPattern) {
          cachedPattern = pattern;
          cachedPatternValid = true;
          cachedEnabled = matchesDebugNamespace(debugNamespace, pattern);
        }
        return cachedEnabled;
      };

      const log: LogFn = (message, metadata) => {
        const alwaysOut = level === 'error' || level === 'warn';
        const debugEnabled = isEnabled();
        // Fast path: nothing will be emitted, so build nothing. The merged
        // metadata spread and the Object.keys probes below allocate on every
        // call otherwise, which feeds minor GC from the replay hot loop.
        if (!alwaysOut && !debugEnabled) return;

        const hasParent = Object.keys(parentMetadata).length > 0;
        const hasCallSite = metadata && Object.keys(metadata).length > 0;
        const merged =
          hasParent || hasCallSite
            ? { ...parentMetadata, ...(metadata ?? {}) }
            : undefined;

        // Always output error/warn to console so users see critical issues.
        // debug/info only output when DEBUG env var matches the namespace.
        //
        // Compose the framing + structured fields + (trimmed) stack into a
        // single string so the runtime's `console.error` / `util.inspect`
        // doesn't quote-escape multi-line stacks or paragraph hints inside
        // a JSON-y object dump. The framing line stays at the top with the
        // structured fields right under it; the stack body (with framework
        // internal frames collapsed) sits at the bottom. See log-format.ts.
        if (alwaysOut) {
          const out = level === 'error' ? console.error : console.warn;
          out(composeLogLine('[workflow-sdk]', message, merged));
        }

        if (debugEnabled) {
          console.debug(`[${debugNamespace}] ${message}`, merged ?? '');
          getActiveSpan()
            .then((span) => {
              span?.addEvent(`${level}.${namespace}`, { message, ...merged });
            })
            .catch(() => {
              // Silently ignore telemetry errors
            });
        }
      };
      return { log, isEnabled };
    };

    const debug = logger('debug');
    return {
      debug: debug.log,
      debugEnabled: debug.isEnabled,
      info: logger('info').log,
      warn: logger('warn').log,
      error: logger('error').log,
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
