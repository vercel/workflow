import { MessageData } from './types.js';

export interface FunctionProxyConfig {
  securityToken: string;
  stepEntrypoint: (request: Request) => Promise<Response>;
  workflowEntrypoint: (request: Request) => Promise<Response>;
}

export interface FunctionProxyFunctions {
  proxyStep: (message: MessageData) => Promise<Response>;
  proxyWorkflow: (message: MessageData) => Promise<Response>;
}

/**
 * Creates function-based proxy functions that call workflow/step entrypoints directly.
 * Workers call entrypoint functions in-process without HTTP overhead.
 */
export function createFunctionProxy(
  config: FunctionProxyConfig
): FunctionProxyFunctions {
  const createHeaders = () => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Workflow-Secret': config.securityToken,
    };

    return headers;
  };

  return {
    proxyWorkflow: async (message: MessageData): Promise<Response> => {
      const request = new Request(
        'https://world-postgres.local/wkf-direct-call',
        {
          method: 'POST',
          headers: createHeaders(),
          body: JSON.stringify(MessageData.encode(message)),
        }
      );

      return config.workflowEntrypoint(request);
    },

    proxyStep: async (message: MessageData): Promise<Response> => {
      const request = new Request(
        'https://world-postgres.local/wkf-direct-call',
        {
          method: 'POST',
          headers: createHeaders(),
          body: JSON.stringify(MessageData.encode(message)),
        }
      );

      return config.stepEntrypoint(request);
    },
  };
}
