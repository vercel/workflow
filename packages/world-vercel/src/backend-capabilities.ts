import { WorkflowWorldError } from '@workflow/errors';
import type { BackendCapabilities } from '@workflow/world';
import z from 'zod';
import type { APIConfig } from './utils.js';
import { makeRequest } from './utils.js';

const BackendCapabilitiesSchema = z.compile(
  z.object({
    dynamicWorkflowStorageVersion: z.number().optional(),
  })
);

/**
 * Reads the backend's advertised capabilities.
 *
 * A backend that predates `/v2/capabilities` answers 404, which means it
 * advertises nothing: that maps to an empty capability set, so callers fail
 * closed with their own "backend does not support" error. Any other failure
 * (5xx, transport) propagates, since it says nothing about what the backend
 * supports.
 */
export function createGetBackendCapabilities(config?: APIConfig) {
  return async (): Promise<BackendCapabilities> => {
    try {
      return await makeRequest({
        endpoint: '/v2/capabilities',
        options: { method: 'GET' },
        config,
        schema: BackendCapabilitiesSchema,
      });
    } catch (error) {
      if (WorkflowWorldError.is(error) && error.status === 404) {
        return {};
      }
      throw error;
    }
  };
}
