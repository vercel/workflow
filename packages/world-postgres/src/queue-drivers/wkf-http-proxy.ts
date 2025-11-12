import { MessageData } from './types.js';

export interface HttpProxyConfig {
  port?: number;
  baseUrl?: string;
  securityToken: string;
}

export interface HttpProxyFunctions {
  proxyWorkflow: (message: MessageData) => Promise<Response>;
  proxyStep: (message: MessageData) => Promise<Response>;
}

/**
 * Creates HTTP-based proxy functions that call the Next.js app's workflow endpoints.
 * Workers communicate with the app via HTTP fetch to .well-known/workflow/v1/* endpoints.
 */
export function createHttpProxy(config: HttpProxyConfig): HttpProxyFunctions {
  const resolveBaseUrl = (): string => {
    if (config.baseUrl) return config.baseUrl;
    if (config.port) return `http://localhost:${config.port}`;
    return 'http://localhost:3000';
  };

  const createHeaders = () => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Workflow-Secret': config.securityToken,
    };

    return headers;
  };

  const baseUrl = resolveBaseUrl();

  return {
    proxyWorkflow: async (message: MessageData): Promise<Response> => {
      return fetch(`${baseUrl}/.well-known/workflow/v1/flow`, {
        method: 'POST',
        headers: createHeaders(),
        body: JSON.stringify(MessageData.encode(message)),
      });
    },

    proxyStep: async (message: MessageData): Promise<Response> => {
      return fetch(`${baseUrl}/.well-known/workflow/v1/step`, {
        method: 'POST',
        headers: createHeaders(),
        body: JSON.stringify(MessageData.encode(message)),
      });
    },
  };
}
