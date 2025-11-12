import { createRequire } from 'node:module';
import Path from 'node:path';
import { MessageData } from './types.js';

const require = createRequire(Path.join(process.cwd(), 'index.js'));

export async function proxyWorkflow(message: MessageData) {
  const workflows = require(process.env.WORKFLOW_POSTGRES_FLOWS!);

  const request = new Request('https://world-postgres.local/wkf-direct-call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(MessageData.encode(message)),
  });

  return (await workflows.__wkf_entrypoint(request)) as Promise<Response>;
}

export async function proxyStep(message: MessageData) {
  const steps = require(process.env.WORKFLOW_POSTGRES_STEPS!);

  const request = new Request('https://world-postgres.local/wkf-direct-call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(MessageData.encode(message)),
  });

  return (await steps.__wkf_entrypoint(request)) as Promise<Response>;
}
