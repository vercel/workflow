import { describe, expect, it } from 'vitest';
import {
  getQueueTopicPrefix,
  parseQueueName,
  QueuePayloadSchema,
  QueuePrefix,
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
});
