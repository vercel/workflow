import debug from 'debug';
import { getActiveSpan } from './telemetry.js';

function createLogger(namespace: string) {
  const baseDebug = debug(`workflow:${namespace}`);

  const logger = (level: string) => {
    const levelDebug = baseDebug.extend(level);

    return (message: string, metadata?: Record<string, any>) => {
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
