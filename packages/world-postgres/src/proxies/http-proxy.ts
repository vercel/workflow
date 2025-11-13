import type { MessageData } from '../queue-drivers/types.js';
import type { WkfProxy } from './types.js';
import { prepareRequestParams } from './utils.js';

export function createHttpProxy(opts: {
  port?: number;
  baseUrl?: string;
  securityToken: string;
}): WkfProxy {
  const resolveBaseUrl = (): string => {
    if (opts.baseUrl) return opts.baseUrl;
    if (opts.port) return `http://localhost:${opts.port}`;
    return 'http://localhost:3000';
  };

  const baseUrl = resolveBaseUrl();

  return {
    proxyWorkflow: async (message: MessageData): Promise<Response> => {
      return fetch(
        `${baseUrl}/.well-known/workflow/v1/flow`,
        prepareRequestParams(message, opts.securityToken)
      );
    },

    proxyStep: async (message: MessageData): Promise<Response> => {
      return fetch(
        `${baseUrl}/.well-known/workflow/v1/step`,
        prepareRequestParams(message, opts.securityToken)
      );
    },
  };
}
