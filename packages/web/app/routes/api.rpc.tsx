/**
 * Resource route that exposes server functions as an RPC-style API.
 *
 * Client code calls these via fetch POST to /api/rpc with a CBOR-encoded
 * body containing { method, params }. Responses are CBOR-encoded, which
 * preserves Uint8Array values for client-side hydration/deserialization.
 */

import { decode, encode } from 'cbor-x';
import {
  cancelRun,
  fetchEvents,
  fetchEventsByCorrelationId,
  fetchHook,
  fetchHooks,
  fetchRun,
  fetchRuns,
  fetchStep,
  fetchSteps,
  fetchStreams,
  fetchWorkflowsManifest,
  getPublicServerConfig,
  recreateRun,
  reenqueueRun,
  resumeHook,
  runHealthCheck,
  wakeUpRun,
} from '~/server/workflow-server-actions.server';
import type { Route } from './+types/api.rpc';

type RpcMethod = keyof typeof handlers;

const handlers = {
  fetchRuns: (p: any) => fetchRuns(p.worldEnv ?? {}, p.params ?? {}),
  fetchRun: (p: any) => fetchRun(p.worldEnv ?? {}, p.runId, p.resolveData),
  fetchSteps: (p: any) => fetchSteps(p.worldEnv ?? {}, p.runId, p.params ?? {}),
  fetchStep: (p: any) =>
    fetchStep(p.worldEnv ?? {}, p.runId, p.stepId, p.resolveData),
  fetchEvents: (p: any) =>
    fetchEvents(p.worldEnv ?? {}, p.runId, p.params ?? {}),
  fetchEventsByCorrelationId: (p: any) =>
    fetchEventsByCorrelationId(
      p.worldEnv ?? {},
      p.correlationId,
      p.params ?? {}
    ),
  fetchHooks: (p: any) => fetchHooks(p.worldEnv ?? {}, p.params ?? {}),
  fetchHook: (p: any) => fetchHook(p.worldEnv ?? {}, p.hookId, p.resolveData),
  cancelRun: (p: any) => cancelRun(p.worldEnv ?? {}, p.runId),
  recreateRun: (p: any) =>
    recreateRun(p.worldEnv ?? {}, p.runId, p.deploymentId),
  reenqueueRun: (p: any) => reenqueueRun(p.worldEnv ?? {}, p.runId),
  wakeUpRun: (p: any) => wakeUpRun(p.worldEnv ?? {}, p.runId, p.options),
  resumeHook: (p: any) => resumeHook(p.worldEnv ?? {}, p.token, p.payload),
  fetchStreams: (p: any) => fetchStreams(p.worldEnv ?? {}, p.runId),
  fetchWorkflowsManifest: (p: any) => fetchWorkflowsManifest(p.worldEnv ?? {}),
  runHealthCheck: (p: any) =>
    runHealthCheck(p.worldEnv ?? {}, p.endpoint, p.options),
  getPublicServerConfig: () => getPublicServerConfig(),
} as const;

function cborResponse(data: unknown, status = 200): Response {
  const encoded = encode(data);
  return new Response(new Uint8Array(encoded), {
    status,
    headers: { 'Content-Type': 'application/cbor' },
  });
}

export async function action({ request }: Route.ActionArgs) {
  // Decode request body — accept both CBOR and JSON
  let body: { method: string; params: any };
  const contentType = request.headers.get('content-type') || '';
  try {
    if (contentType.includes('application/cbor')) {
      const buffer = await request.arrayBuffer();
      body = decode(new Uint8Array(buffer));
    } else {
      body = await request.json();
    }
  } catch {
    return cborResponse(
      {
        success: false,
        error: { message: 'Malformed request body', layer: 'server' },
      },
      400
    );
  }

  const { method, params } = body;

  if (!method || !(method in handlers)) {
    return cborResponse(
      {
        success: false,
        error: { message: `Unknown method: ${method}`, layer: 'server' },
      },
      400
    );
  }

  try {
    const result = await handlers[method as RpcMethod](params ?? {});
    return cborResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return cborResponse(
      { success: false, error: { message, layer: 'server' } },
      500
    );
  }
}

// Also support GET for read operations (JSON — no binary data needed)
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const method = url.searchParams.get('method');

  if (method === 'getPublicServerConfig') {
    const result = await getPublicServerConfig();
    return Response.json(result);
  }

  return Response.json({ error: 'Use POST for RPC calls' }, { status: 405 });
}
