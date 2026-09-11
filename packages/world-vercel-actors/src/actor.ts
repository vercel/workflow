import { AsyncLocalStorage } from 'node:async_hooks';
import { globalSingleton } from '@workflow/utils';
import {
  ExecutionInputSchema,
  ExecutionInvariantError,
  type ExecutionSession,
  getQueueTopicPrefix,
  resolveQueueNamespace,
  type World,
} from '@workflow/world';

const registries = globalSingleton(
  '@workflow/world-vercel-actors//sessions',
  1,
  () => new WeakMap<World, Map<string, ExecutionSession>>()
);

/** Vercel-specific placement/ingress. Core supplies only the execution session. */
export function createActorHandler(
  world: World,
  factory: (runId: string) => ExecutionSession,
  headerName: () => string | undefined,
  namespace?: string
) {
  const execution = world.execution;
  if (!execution) throw new Error('Actor World requires the execution API');
  let sessions = registries.get(world);
  if (!sessions) {
    sessions = new Map();
    registries.set(world, sessions);
  }
  const registry = sessions;
  const deliveryAffinity = new AsyncLocalStorage<string>();
  const handle = world.createQueueHandler(
    getQueueTopicPrefix('workflow', resolveQueueNamespace(namespace)),
    async (payload) => {
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('runId' in payload) ||
        typeof payload.runId !== 'string'
      ) {
        throw new ExecutionInvariantError('Actor delivery requires runId');
      }
      const runId = payload.runId;
      if (deliveryAffinity.getStore() !== runId) {
        const message = 'Delivered affinity ID does not equal run ID';
        await execution.quarantine(runId, {
          code: 'EXECUTION_INVARIANT_VIOLATION',
          message,
        });
        throw new ExecutionInvariantError(message);
      }
      let session = registry.get(runId);
      if (!session) {
        if (registry.size >= 128)
          throw new Error('Actor POC session capacity exceeded');
        session = factory(runId);
        registry.set(runId, session);
      }
      await session.receive(
        'executionInput' in payload && payload.executionInput !== undefined
          ? ExecutionInputSchema.parse(payload.executionInput)
          : undefined
      );
    }
  );
  return async (request: Request) => {
    const name = headerName();
    const affinity = name && request.headers.get(name);
    if (!affinity)
      throw new ExecutionInvariantError(
        'Actor invocation is missing its configured affinity header'
      );
    return deliveryAffinity.run(affinity, () => handle(request));
  };
}
