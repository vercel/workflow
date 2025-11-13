import type { MessageData } from '../queue-drivers/types.js';
import type { WkfProxy } from './types.js';
import { prepareRequestParams } from './utils.js';

export function createFunctionProxy(opts: {
  securityToken: string;
  stepEntrypoint: (request: Request) => Promise<Response>;
  workflowEntrypoint: (request: Request) => Promise<Response>;
}): WkfProxy {
  return {
    proxyWorkflow: async (message: MessageData): Promise<Response> => {
      const request = new Request(
        'https://world-postgres.local/wkf-direct-call',
        prepareRequestParams(message, opts.securityToken)
      );

      return opts.workflowEntrypoint(request);
    },

    proxyStep: async (message: MessageData): Promise<Response> => {
      const request = new Request(
        'https://world-postgres.local/wkf-direct-call',
        prepareRequestParams(message, opts.securityToken)
      );

      return opts.stepEntrypoint(request);
    },
  };
}
