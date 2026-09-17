import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { globalSingleton } from '@workflow/utils';

interface RoutingObservation {
  transport: 'vqs' | 'direct';
  invocationId: string;
  runId?: string;
  requestId?: string;
  messageId?: string;
  attempt?: number;
  expectedAffinityId?: string;
  receivedAffinityId?: string | null;
  requestedDeploymentId?: string;
  receivedDeploymentId?: string | null;
  elapsedMs?: number;
  status?: number;
  ok?: boolean;
}

/** Routing headers are observations, not proof that requests share a process. */
export function logInvocationRouting(
  event: string,
  observation: RoutingObservation
) {
  const state = globalSingleton(
    '@workflow/world-vercel//routingDiagnostics',
    1,
    () => ({
      instanceId: randomUUID(),
      sequence: 0,
    })
  );
  const received = observation.receivedAffinityId;
  console.info(
    JSON.stringify({
      component: 'workflow-invocation',
      event,
      at: new Date().toISOString(),
      processInstanceId: state.instanceId,
      processSequence: ++state.sequence,
      pid: process.pid,
      hostname: hostname(),
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
      region: process.env.VERCEL_REGION,
      ...observation,
      affinityStatus: !received
        ? 'absent'
        : !observation.expectedAffinityId
          ? 'unverified'
          : received === observation.expectedAffinityId
            ? 'match'
            : 'different',
    })
  );
}
