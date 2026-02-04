import debug from 'debug';
import { getActiveSpan } from './telemetry.js';

function createLogger(namespace: string) {
  const baseDebug = debug(`workflow:${namespace}`);

  const logger = (level: string) => {
    const levelDebug = baseDebug.extend(level);

    return (message: string, metadata?: Record<string, any>) => {
      // Always output error/warn to console so users see critical issues
      // debug/info only output when DEBUG env var is set
      if (level === 'error') {
        console.error(`[Workflow] ${message}`, metadata ?? '');
      } else if (level === 'warn') {
        console.warn(`[Workflow] ${message}`, metadata ?? '');
      }

      // Also log to debug library for verbose output when DEBUG is enabled
      levelDebug(message, metadata);

      if (levelDebug.enabled) {
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
