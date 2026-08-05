import { describe, expect, it } from 'vitest';
import {
  getQueueTopicPrefix,
  parseQueueName,
  QueuePayloadSchema,
  QueuePrefix,
  RunInputSchema,
  ValidQueueName,
} from './queue.js';

describe('getQueueTopicPrefix', () => {
  it('returns default workflow prefix without namespace', () => {
    expect(getQueueTopicPrefix('workflow')).toBe('__wkf_workflow_');
  });

  it('returns namespaced workflow prefix', () => {
    expect(getQueueTopicPrefix('workflow', 'custom')).toBe(
      '__custom_wkf_workflow_'
    );
  });

  it('accepts multi-character namespace', () => {
    expect(getQueueTopicPrefix('workflow', 'myframework123')).toBe(
      '__myframework123_wkf_workflow_'
    );
  });

  it('rejects the retired step queue kind at runtime', () => {
    expect(() => getQueueTopicPrefix('step' as never)).toThrow(
      'Unsupported queue kind: step'
    );
  });

  it('throws for namespace starting with a digit', () => {
    expect(() => getQueueTopicPrefix('workflow', '123abc')).toThrow();
  });

  it('throws for uppercase namespace', () => {
    expect(() => getQueueTopicPrefix('workflow', 'Custom')).toThrow();
  });

  it('throws for empty namespace', () => {
    expect(() => getQueueTopicPrefix('workflow', '')).toThrow();
  });

  it('throws for namespace with special characters', () => {
    expect(() => getQueueTopicPrefix('workflow', 'my-framework')).toThrow();
    expect(() => getQueueTopicPrefix('workflow', 'my_framework')).toThrow();
  });

  it('returns undefined namespace same as no namespace', () => {
    expect(getQueueTopicPrefix('workflow', undefined)).toBe(
      getQueueTopicPrefix('workflow')
    );
  });
});

describe('QueuePrefix schema', () => {
  it('accepts default workflow prefix', () => {
    expect(QueuePrefix.parse('__wkf_workflow_')).toBe('__wkf_workflow_');
  });

  it('accepts namespaced workflow prefix', () => {
    expect(QueuePrefix.parse('__custom_wkf_workflow_')).toBe(
      '__custom_wkf_workflow_'
    );
  });

  it('rejects retired step prefixes', () => {
    expect(() => QueuePrefix.parse('__wkf_step_')).toThrow();
    expect(() => QueuePrefix.parse('__custom_wkf_step_')).toThrow();
  });

  it('rejects invalid prefix', () => {
    expect(() => QueuePrefix.parse('bad_prefix')).toThrow();
  });

  it('rejects prefix without trailing underscore', () => {
    expect(() => QueuePrefix.parse('__wkf_workflow')).toThrow();
  });

  it('rejects uppercase namespace', () => {
    expect(() => QueuePrefix.parse('__Custom_wkf_workflow_')).toThrow();
  });
});

describe('ValidQueueName schema', () => {
  it('accepts default queue names', () => {
    expect(ValidQueueName.parse('__wkf_workflow_myFlow')).toBe(
      '__wkf_workflow_myFlow'
    );
  });

  it('accepts namespaced queue names', () => {
    expect(ValidQueueName.parse('__custom_wkf_workflow_myFlow')).toBe(
      '__custom_wkf_workflow_myFlow'
    );
  });

  it('rejects retired step queue names', () => {
    expect(() => ValidQueueName.parse('__wkf_step_myStep')).toThrow();
  });

  it('rejects prefix-only without a name', () => {
    expect(() => ValidQueueName.parse('__wkf_workflow_')).toThrow();
  });

  it('rejects invalid names', () => {
    expect(() => ValidQueueName.parse('not_a_queue_name')).toThrow();
  });
});

describe('parseQueueName', () => {
  it('parses default workflow queue names', () => {
    expect(parseQueueName('__wkf_workflow_myFlow')).toEqual({
      prefix: '__wkf_workflow_',
      id: 'myFlow',
    });
  });

  it('parses namespaced workflow queue names', () => {
    expect(parseQueueName('__custom_wkf_workflow_myFlow')).toEqual({
      prefix: '__custom_wkf_workflow_',
      id: 'myFlow',
    });
  });
});

describe('QueuePayloadSchema', () => {
  // A probe issued to prepare a cross-deployment `start()` carries the run id
  // it is about to create, which also makes it satisfy
  // `WorkflowInvokePayloadSchema` (whose only required field is `runId`). Zod
  // unions return the first matching member and strip keys that member doesn't
  // declare, so if the invoke member were matched first the discriminator would
  // be dropped and the runtime would reinterpret the probe as a run replay.
  it('preserves the health-check discriminator on a probe that carries a runId', () => {
    const parsed = QueuePayloadSchema.parse({
      __healthCheck: true,
      correlationId: 'corr_123',
      runId: 'wrun_01ABC',
    });

    expect(parsed).toEqual({
      __healthCheck: true,
      correlationId: 'corr_123',
      runId: 'wrun_01ABC',
    });
  });

  it('preserves health-check payloads that carry no runId', () => {
    expect(
      QueuePayloadSchema.parse({
        __healthCheck: true,
        correlationId: 'corr_123',
      })
    ).toEqual({ __healthCheck: true, correlationId: 'corr_123' });
  });

  it('still resolves workflow invoke payloads', () => {
    expect(
      QueuePayloadSchema.parse({ runId: 'wrun_01ABC', stepId: 'step_1' })
    ).toEqual({ runId: 'wrun_01ABC', stepId: 'step_1' });
  });

  // Resilient step dispatch: a step message may carry `stepInput` with the
  // serialized (binary) step input, which the consumer re-ensures the
  // step_created event from. The bytes must survive parsing untouched.
  it('round-trips a step message carrying stepInput', () => {
    const input = new Uint8Array([1, 2, 3]);
    const parsed = QueuePayloadSchema.parse({
      runId: 'wrun_01ABC',
      stepId: 'step_1',
      stepName: 'myStep',
      stepInput: { input },
    });
    expect(parsed).toEqual({
      runId: 'wrun_01ABC',
      stepId: 'step_1',
      stepName: 'myStep',
      stepInput: { input },
    });
    expect((parsed as { stepInput: { input: unknown } }).stepInput.input).toBe(
      input
    );
  });
});

describe('RunInputSchema environment', () => {
  const baseRunInput = {
    input: { foo: 'bar' },
    deploymentId: 'dpl_123',
    workflowName: 'myWorkflow',
    specVersion: 5,
  };

  it('round-trips the creator environment when present', () => {
    expect(
      RunInputSchema.parse({ ...baseRunInput, environment: 'preview' })
    ).toEqual({ ...baseRunInput, environment: 'preview' });
  });

  it('parses without an environment, leaving the field absent', () => {
    const parsed = RunInputSchema.parse(baseRunInput);
    expect(parsed).toEqual(baseRunInput);
    expect('environment' in parsed).toBe(false);
  });

  it('rejects a non-string environment rather than coercing it', () => {
    expect(
      RunInputSchema.safeParse({ ...baseRunInput, environment: 1 }).success
    ).toBe(false);
  });

  // Wire compatibility in the OTHER direction: an SDK older than this field
  // must be able to consume a message minted by a newer one. `z.object` strips
  // unknown keys rather than rejecting, so the old consumer drops `environment`
  // and processes the message normally. If this ever becomes `.strict()`, every
  // in-flight message from a newer client starts failing validation on older
  // deployments.
  it('tolerates unknown keys by stripping them, so old consumers keep working', () => {
    const parsed = RunInputSchema.parse({
      ...baseRunInput,
      someFutureField: 'ignored',
    });
    expect(parsed).toEqual(baseRunInput);
  });

  it('carries the environment through a full invoke payload', () => {
    const parsed = QueuePayloadSchema.parse({
      runId: 'wrun_01ABC',
      runInput: { ...baseRunInput, environment: 'production' },
    });
    expect(parsed).toMatchObject({
      runId: 'wrun_01ABC',
      runInput: { environment: 'production' },
    });
  });
});
