import { AsyncLocalStorage } from 'node:async_hooks';

export const WORKFLOW_STEP_IDS_HEADER = 'x-vercel-internal-workflow-step-ids';

type InvocationStepIds = Set<string>;

const INVOCATION_STEP_IDS_STORAGE_SYMBOL = Symbol.for(
  'WORKFLOW_INVOCATION_STEP_IDS_STORAGE'
);

const invocationStepIdsStorage: AsyncLocalStorage<InvocationStepIds> = (() => {
  const store = globalThis as typeof globalThis & {
    [INVOCATION_STEP_IDS_STORAGE_SYMBOL]?: AsyncLocalStorage<InvocationStepIds>;
  };
  store[INVOCATION_STEP_IDS_STORAGE_SYMBOL] ??=
    new AsyncLocalStorage<InvocationStepIds>();
  return store[INVOCATION_STEP_IDS_STORAGE_SYMBOL];
})();

export function withInvocationStepIds<T>(callback: () => T): T {
  return invocationStepIdsStorage.run(new Set(), callback);
}

export function recordInvocationStepId(stepId: string): void {
  invocationStepIdsStorage.getStore()?.add(stepId);
}

export function attachInvocationStepIds(response: Response): Response {
  const stepIds = Array.from(invocationStepIdsStorage.getStore() ?? []);
  const headers = new Headers(response.headers);
  headers.set(WORKFLOW_STEP_IDS_HEADER, JSON.stringify(stepIds));

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
