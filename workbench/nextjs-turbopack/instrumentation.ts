import { registerOTel } from '@vercel/otel';

const SQLITE_WORLD = '@workflow/world-sqlite';
const FUNCTION_METADATA_PROPERTIES = new Set([
  'length',
  'name',
  'prototype',
  'arguments',
  'caller',
]);

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  );
}

function ownDataPropertyValues(candidate: object): unknown[] {
  const ignoredProperties =
    typeof candidate === 'function' ? FUNCTION_METADATA_PROPERTIES : undefined;
  return Object.entries(Object.getOwnPropertyDescriptors(candidate)).flatMap(
    ([property, descriptor]) =>
      ignoredProperties?.has(property) || !('value' in descriptor)
        ? []
        : [descriptor.value]
  );
}

function sqliteQueueName(workflowId: string, namespace?: string): string {
  if (namespace !== undefined && !/^[a-z][a-z0-9]*$/.test(namespace)) {
    throw new Error(
      `Invalid WORKFLOW_QUEUE_NAMESPACE ${JSON.stringify(namespace)}`
    );
  }
  const prefix = namespace ? `__${namespace}_wkf_workflow_` : '__wkf_workflow_';
  return `${prefix}${workflowId}`;
}

function sqliteQueueNames(
  allWorkflows: Record<string, Record<string, unknown>>
): string[] {
  const namespace = process.env.WORKFLOW_QUEUE_NAMESPACE;
  const queueNames = new Set<string>([
    sqliteQueueName('health_check', namespace),
  ]);

  // A module may export a workflow function directly, an object of workflow
  // functions, or a class whose transformed static methods carry workflowId.
  // Static class methods are non-enumerable, so Object.values() alone misses
  // them and leaves their durable messages with no registered consumer.
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (!isObjectLike(candidate) || seen.has(candidate)) return;
    seen.add(candidate);

    const workflowId = (candidate as { workflowId?: unknown }).workflowId;
    if (typeof workflowId === 'string') {
      queueNames.add(sqliteQueueName(workflowId, namespace));
    }

    for (const value of ownDataPropertyValues(candidate)) {
      visit(value);
    }
  };

  for (const workflowModule of Object.values(allWorkflows)) {
    visit(workflowModule);
  }
  return [...queueNames].sort();
}

export async function register() {
  registerOTel({
    serviceName: 'nextjs-turbopack',
    instrumentationConfig: {
      fetch: {
        // By default @vercel/otel only propagates W3C trace context to Vercel
        // deployment URLs, so outgoing requests to the workflow-server
        // (vercel-workflow.com) and the Vercel Queue Service
        // (*.vercel-queue.com) get a client span with no `traceparent` header
        // — which breaks the trace link to those services' spans in APM.
        // Explicitly propagate context to both domains so traces stay
        // correlated end to end.
        // https://vercel.com/docs/tracing/instrumentation#configuring-context-propagation
        propagateContextUrls: [/vercel-workflow\.com/, /vercel-queue\.com/],
      },
    },
  });

  // The native SQLite worker is process-local and must know both the exact
  // queue names this build can execute and the loopback endpoint before it
  // claims durable messages. Keep native imports out of the Edge runtime.
  if (
    process.env.NEXT_RUNTIME !== 'nodejs' ||
    process.env.WORKFLOW_TARGET_WORLD !== SQLITE_WORLD
  ) {
    return;
  }

  const baseUrl =
    process.env.WORKFLOW_LOCAL_BASE_URL ??
    (process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : undefined);
  if (!baseUrl) {
    throw new Error(
      'WORKFLOW_LOCAL_BASE_URL or PORT is required for @workflow/world-sqlite'
    );
  }

  // Keep the native adapter external to Turbopack. Bundling it rewrites its
  // runtime N-API require into an unresolvable dynamic module expression.
  // Resolve from the application root rather than `import.meta.url`, whose
  // value points at Turbopack's virtual /ROOT tree in the emitted chunk.
  const runtimeRequire = process
    .getBuiltinModule('node:module')
    .createRequire(`${process.cwd()}/package.json`);
  const { createWorld, registerHost } = runtimeRequire(
    SQLITE_WORLD
  ) as typeof import('@workflow/world-sqlite');
  const [{ getWorld, setWorld }, { allWorkflows }] = await Promise.all([
    import('workflow/runtime'),
    import('./_workflows'),
  ]);
  registerHost({ queueNames: sqliteQueueNames(allWorkflows), baseUrl });
  // Seed the runtime's process-wide cache before getWorld() tries to resolve
  // the custom package itself; a dynamic package import cannot be represented
  // in a standalone Turbopack server chunk.
  const configuredWorld = createWorld();
  setWorld(configuredWorld);
  const world = await getWorld();
  await world.start?.();
}
