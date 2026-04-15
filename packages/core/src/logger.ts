import { getActiveSpan } from './telemetry.js';

type DebugLogger = ((
  message: string,
  metadata?: Record<string, unknown>
) => void) & {
  enabled?: boolean;
  extend(suffix: string): DebugLogger;
};

type DebugFactory =
  | ((namespace: string) => DebugLogger)
  | {
      default?: (namespace: string) => DebugLogger;
    };

let cachedDebugEnv: string | undefined;
let cachedDebugFactory: ((namespace: string) => DebugLogger) | null = null;

function loadDebugFactory(): ((namespace: string) => DebugLogger) | null {
  const currentDebugEnv = process.env.DEBUG;
  if (!currentDebugEnv) {
    cachedDebugEnv = undefined;
    cachedDebugFactory = null;
    return null;
  }

  if (cachedDebugEnv === currentDebugEnv) {
    return cachedDebugFactory;
  }

  cachedDebugEnv = currentDebugEnv;

  try {
    const getRuntimeRequire = new Function(
      'return typeof require !== "undefined" ? require : undefined;'
    ) as () => ((specifier: string) => unknown) | undefined;
    const runtimeRequire = getRuntimeRequire();

    if (!runtimeRequire) {
      cachedDebugFactory = null;
      return null;
    }

    const loadedModule = runtimeRequire('debug') as DebugFactory;
    const debugFactory =
      typeof loadedModule === 'function' ? loadedModule : loadedModule.default;

    cachedDebugFactory =
      typeof debugFactory === 'function' ? debugFactory : null;
  } catch {
    cachedDebugFactory = null;
  }

  return cachedDebugFactory;
}

function createLogger(namespace: string) {
  const baseDebug = loadDebugFactory()?.(`workflow:${namespace}`);

  const logger = (level: string) => {
    const levelDebug = baseDebug?.extend(level);

    return (message: string, metadata?: Record<string, any>) => {
      // Always output error/warn to console so users see critical issues
      // debug/info only output when DEBUG env var is set
      if (level === 'error') {
        console.error(`[Workflow] ${message}`, metadata ?? '');
      } else if (level === 'warn') {
        console.warn(`[Workflow] ${message}`, metadata ?? '');
      }

      // Also log to debug library for verbose output when DEBUG is enabled
      levelDebug?.(message, metadata);

      if (levelDebug?.enabled) {
        getActiveSpan()
          .then((span) => {
            span?.addEvent(`${level}.${namespace}`, { message, ...metadata });
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
  };
}

export const stepLogger = createLogger('step');
export const runtimeLogger = createLogger('runtime');
export const webhookLogger = createLogger('webhook');
export const eventsLogger = createLogger('events');
export const adapterLogger = createLogger('adapter');
