import type { BackendCapabilities } from '@workflow/world';
import z from 'zod';
import type { APIConfig } from './utils.js';
import { makeRequest } from './utils.js';

const BackendCapabilitiesSchema = z.compile(
  z.object({
    dynamicWorkflowStorageVersion: z.number().optional(),
  })
);

export function createGetBackendCapabilities(config?: APIConfig) {
  return (): Promise<BackendCapabilities> =>
    makeRequest({
      endpoint: '/v2/capabilities',
      options: { method: 'GET' },
      config,
      schema: BackendCapabilitiesSchema,
    });
}
