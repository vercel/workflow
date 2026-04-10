import { getActiveSpan } from './telemetry.js';

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

function createLogger(namespace: string) {
  const logger = (level: string) => {
    const debugNamespace = `workflow:${namespace}:${level}`;

    return (message: string, metadata?: Record<string, any>) => {
      const debugEnabled = matchesDebugNamespace(
        debugNamespace,
        process.env.DEBUG
      );

      // Always output error/warn to console so users see critical issues
      // debug/info only output when DEBUG env var is set
      if (level === 'error') {
        console.error(`[Workflow] ${message}`, metadata ?? '');
      } else if (level === 'warn') {
        console.warn(`[Workflow] ${message}`, metadata ?? '');
      }

      if (debugEnabled) {
        console.debug(`[${debugNamespace}] ${message}`, metadata ?? '');
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
