import {
  type AuthInfo,
  AuthInfoSchema,
  type AuthProvider,
  type HealthCheckResponse,
  HealthCheckResponseSchema,
} from '@workflow/world';
import type { APIConfig } from './utils.js';
import { makeRequest } from './utils.js';

// Functions
export async function getAuthInfo(config?: APIConfig): Promise<AuthInfo> {
  return makeRequest({
    endpoint: '/v1',
    options: { method: 'GET' },
    config,
    schema: AuthInfoSchema,
  });
}

export async function checkHealth(
  config?: APIConfig
): Promise<HealthCheckResponse> {
  return makeRequest({
    endpoint: '/v1/health',
    options: { method: 'GET' },
    config,
    schema: HealthCheckResponseSchema,
  });
}

export function createAuth(config?: APIConfig): AuthProvider {
  return {
    checkHealth: () => checkHealth(config),
    getAuthInfo: () => getAuthInfo(config),
  };
}
