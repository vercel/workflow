import type { MessageData } from '../queue-drivers/types.js';
import type { WkfProxy } from './types.js';
import { prepareRequestParams } from './utils.js';

export function createHttpProxy(opts: {
  port?: number;
  baseUrl?: string;
  securityToken: string;
}): WkfProxy {
  // Resolve baseUrl lazily at request time to support dynamic port detection
  const getBaseUrl = (): string => {
    if (opts.baseUrl) return opts.baseUrl;
    if (opts.port) return `http://localhost:${opts.port}`;
    // Check for PORT env var (set by server after binding)
    if (process.env.PORT) return `http://localhost:${process.env.PORT}`;
    return 'http://localhost:3000';
  };

  return {
    proxyWorkflow: async (message: MessageData): Promise<Response> => {
      return fetch(
        `${getBaseUrl()}/.well-known/workflow/v1/flow`,
        prepareRequestParams(message, opts.securityToken)
      );
    },

    proxyStep: async (message: MessageData): Promise<Response> => {
      return fetch(
        `${getBaseUrl()}/.well-known/workflow/v1/step`,
        prepareRequestParams(message, opts.securityToken)
      );
    },
  };
}
