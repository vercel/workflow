import type { MessageData } from '../queue-drivers/types.js';

export interface WkfProxy {
  proxyWorkflow: (message: MessageData) => Promise<Response>;
  proxyStep: (message: MessageData) => Promise<Response>;
}
