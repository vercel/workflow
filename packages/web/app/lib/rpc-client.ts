/**
 * RPC client for calling server functions via the /api/rpc resource route.
 *
 * Uses CBOR encoding for both requests and responses to preserve
 * Uint8Array values (binary serialized data) across the wire.
 * Client-side code is responsible for hydrating/deserializing the data.
 */

import type {
  Event,
  Hook,
  Step,
  WorkflowRun,
  WorkflowRunStatus,
} from '@workflow/world';
import { decode, encode } from 'cbor-x';
import type {
  EnvMap,
  HealthCheckEndpoint,
  HealthCheckResult,
  PaginatedResult,
  PublicServerConfig,
  ResumeHookResult,
  ServerActionError,
  ServerActionResult,
  StopSleepOptions,
  StopSleepResult,
} from '~/lib/types';

async function rpc<T>(method: string, params?: any): Promise<T> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/cbor',
      Accept: 'application/cbor',
    },
    body: new Uint8Array(encode({ method, params: params ?? {} })),
  });
  if (!res.ok) {
    // Try to extract structured error from CBOR response body
    try {
      const buffer = await res.arrayBuffer();
      const errorBody = decode(new Uint8Array(buffer));
      if (errorBody?.error?.message) {
        throw new Error(errorBody.error.message);
      }
    } catch (decodeErr) {
      if (
        decodeErr instanceof Error &&
        decodeErr.message !== `RPC call ${method} failed`
      ) {
        throw decodeErr;
      }
    }
    throw new Error(
      `RPC call ${method} failed: ${res.status} ${res.statusText}`
    );
  }
  const buffer = await res.arrayBuffer();
  return decode(new Uint8Array(buffer));
}

// --- Data fetching functions (same signatures as the old server actions) ---

export async function fetchRuns(
  worldEnv: EnvMap,
  params: {
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
    limit?: number;
    workflowName?: string;
    status?: WorkflowRunStatus;
  }
): Promise<ServerActionResult<PaginatedResult<WorkflowRun>>> {
  return rpc('fetchRuns', { worldEnv, params });
}

export async function fetchRun(
  worldEnv: EnvMap,
  runId: string,
  resolveData: 'none' | 'all' = 'all'
): Promise<ServerActionResult<WorkflowRun>> {
  return rpc('fetchRun', { worldEnv, runId, resolveData });
}

export async function fetchSteps(
  worldEnv: EnvMap,
  runId: string,
  params: {
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
    limit?: number;
  }
): Promise<ServerActionResult<PaginatedResult<Step>>> {
  return rpc('fetchSteps', { worldEnv, runId, params });
}

export async function fetchStep(
  worldEnv: EnvMap,
  runId: string,
  stepId: string,
  resolveData: 'none' | 'all' = 'all'
): Promise<ServerActionResult<Step>> {
  return rpc('fetchStep', { worldEnv, runId, stepId, resolveData });
}

export async function fetchEvents(
  worldEnv: EnvMap,
  runId: string,
  params: {
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
    limit?: number;
    withData?: boolean;
  }
): Promise<ServerActionResult<PaginatedResult<Event>>> {
  return rpc('fetchEvents', { worldEnv, runId, params });
}

export async function fetchEventsByCorrelationId(
  worldEnv: EnvMap,
  correlationId: string,
  params: {
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
    limit?: number;
    withData?: boolean;
  }
): Promise<ServerActionResult<PaginatedResult<Event>>> {
  return rpc('fetchEventsByCorrelationId', { worldEnv, correlationId, params });
}

export async function fetchHooks(
  worldEnv: EnvMap,
  params: {
    runId?: string;
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
    limit?: number;
  }
): Promise<ServerActionResult<PaginatedResult<Hook>>> {
  return rpc('fetchHooks', { worldEnv, params });
}

export async function fetchHook(
  worldEnv: EnvMap,
  hookId: string,
  resolveData: 'none' | 'all' = 'all'
): Promise<ServerActionResult<Hook>> {
  return rpc('fetchHook', { worldEnv, hookId, resolveData });
}

export async function cancelRun(
  worldEnv: EnvMap,
  runId: string
): Promise<ServerActionResult<void>> {
  return rpc('cancelRun', { worldEnv, runId });
}

export async function recreateRun(
  worldEnv: EnvMap,
  runId: string,
  deploymentId?: string
): Promise<ServerActionResult<string>> {
  return rpc('recreateRun', { worldEnv, runId, deploymentId });
}

export async function reenqueueRun(
  worldEnv: EnvMap,
  runId: string
): Promise<ServerActionResult<void>> {
  return rpc('reenqueueRun', { worldEnv, runId });
}

export async function wakeUpRun(
  worldEnv: EnvMap,
  runId: string,
  options?: StopSleepOptions
): Promise<ServerActionResult<StopSleepResult>> {
  return rpc('wakeUpRun', { worldEnv, runId, options });
}

export async function resumeHook(
  worldEnv: EnvMap,
  token: string,
  payload: unknown
): Promise<ServerActionResult<ResumeHookResult>> {
  return rpc('resumeHook', { worldEnv, token, payload });
}

export async function fetchStreams(
  worldEnv: EnvMap,
  runId: string
): Promise<ServerActionResult<string[]>> {
  return rpc('fetchStreams', { worldEnv, runId });
}

export async function fetchWorkflowsManifest(
  worldEnv: EnvMap
): Promise<ServerActionResult<any>> {
  return rpc('fetchWorkflowsManifest', { worldEnv });
}

export async function runHealthCheck(
  worldEnv: EnvMap,
  endpoint: HealthCheckEndpoint,
  options?: { timeout?: number }
): Promise<ServerActionResult<HealthCheckResult>> {
  return rpc('runHealthCheck', { worldEnv, endpoint, options });
}

// Note: readStreamServerAction returns a ReadableStream which can't go through CBOR RPC.
// Stream reading uses a dedicated resource route at /api/stream/:streamId.
