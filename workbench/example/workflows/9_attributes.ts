/**
 * Demonstrates the workflow attributes API (V1).
 *
 * NOTE: As of this commit, setAttribute / setAttributes / getAttribute /
 * getAttributes are NOT yet implemented in @workflow/core. The workflows
 * here are written against the proposed API surface so the e2e tests in
 * `packages/core/e2e/attributes.test.ts` can be flipped on by removing
 * `.skip` once implementation lands.
 *
 * Where the API is referenced, we cast through `as any` so the file
 * typechecks today. Each cast carries a TODO so they are easy to grep
 * and remove during implementation.
 */
import * as workflow from 'workflow';

// TODO(attributes): drop these casts once the real exports exist.
const setAttribute = (
  workflow as unknown as {
    setAttribute(key: string, value: string | undefined): Promise<void>;
  }
).setAttribute;
const setAttributes = (
  workflow as unknown as {
    setAttributes(attrs: Record<string, string | undefined>): Promise<void>;
  }
).setAttributes;
const getAttribute = (
  workflow as unknown as {
    getAttribute(key: string): string | undefined;
  }
).getAttribute;
const getAttributes = (
  workflow as unknown as {
    getAttributes(): Record<string, string>;
  }
).getAttributes;

/**
 * Sets a couple of attributes from inside a step using the batch helper, then
 * reads them back to demonstrate read-your-writes.
 */
async function processOrderStep(
  orderId: string
): Promise<Record<string, string>> {
  'use step';

  // Single-key write.
  await setAttribute('orderId', orderId);
  // Batch write — both keys land in one attr_set event with two `changes`.
  await setAttributes({ stepKind: 'process', region: 'us-east-1' });

  // Read-your-writes inside the same step body.
  const orderIdSeen = getAttribute('orderId');
  if (orderIdSeen !== orderId) {
    throw new Error(
      `read-your-writes broken: expected orderId="${orderId}", got "${orderIdSeen}"`
    );
  }

  return getAttributes();
}

/**
 * Workflow exercising the full V1 surface:
 *   - reads an initial attribute set at start() time (carried on run_created)
 *   - writes from the workflow body (writer = workflow)
 *   - awaits a step that writes (writer = step + stepId + attempt)
 *   - unsets a key with `undefined`
 *   - returns the final getAttributes() snapshot
 */
export async function attributesWorkflow(orderId: string) {
  'use workflow';

  // tenant comes from `start({ attributes: { tenant: '...' } })` (initial
  // attributes carried on run_created, no attr_set event emitted at birth).
  const tenant = getAttribute('tenant');

  await setAttribute('phase', 'init');

  const stepView = await processOrderStep(orderId);

  // Workflow observes the step's writes once it resumes after the step.
  const orderIdAfterStep = getAttribute('orderId');

  await setAttribute('phase', 'done');
  // Unset the per-step `region` attribute now that the work is finished;
  // exercises the `null` value path in the attr_set event.
  await setAttribute('region', undefined);

  return {
    tenant,
    stepView,
    orderIdAfterStep,
    final: getAttributes(),
  };
}

/**
 * Stresses the retry-attribution path: a step that fails on the first attempt
 * and succeeds on the second, with an attribute write on each attempt. The
 * event log should record both attr_set events with `writer.attempt` of 1
 * and 2 respectively.
 */
async function retryingStep(): Promise<void> {
  'use step';

  // TODO(attributes): use getStepMetadata().attempt in the real API to make
  // the check explicit. For now we rely on the runtime's retry behavior:
  // first attempt throws; second attempt succeeds.
  const ctx = workflow.getStepMetadata();
  await setAttribute(`attemptedAt-${ctx.attempt}`, new Date().toISOString());

  if (ctx.attempt === 1) {
    throw new Error('Synthetic retryable error to exercise attempt counter');
  }
}

export async function attributesRetryWorkflow() {
  'use workflow';
  await retryingStep();
  return getAttributes();
}
