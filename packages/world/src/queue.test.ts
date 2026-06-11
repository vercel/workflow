import { describe, expect, it } from 'vitest';
import {
  getQueuePrefixKind,
  getQueueTopicPrefix,
  parseQueueName,
  QueuePrefix,
  ValidQueueName,
} from './queue.js';

describe('getQueueTopicPrefix', () => {
  it('returns default workflow prefix without namespace', () => {
    expect(getQueueTopicPrefix('workflow')).toBe('__wkf_workflow_');
  });

  it('returns default step prefix without namespace', () => {
    expect(getQueueTopicPrefix('step')).toBe('__wkf_step_');
  });

  it('returns namespaced workflow prefix', () => {
    expect(getQueueTopicPrefix('workflow', 'custom')).toBe(
      '__custom_wkf_workflow_'
    );
  });

  it('returns namespaced step prefix', () => {
    expect(getQueueTopicPrefix('step', 'custom')).toBe('__custom_wkf_step_');
  });

  it('accepts multi-character namespace', () => {
    expect(getQueueTopicPrefix('workflow', 'myframework123')).toBe(
      '__myframework123_wkf_workflow_'
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

  it('accepts default step prefix', () => {
    expect(QueuePrefix.parse('__wkf_step_')).toBe('__wkf_step_');
  });

  it('accepts namespaced workflow prefix', () => {
    expect(QueuePrefix.parse('__custom_wkf_workflow_')).toBe(
      '__custom_wkf_workflow_'
    );
  });

  it('accepts namespaced step prefix', () => {
    expect(QueuePrefix.parse('__custom_wkf_step_')).toBe('__custom_wkf_step_');
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

describe('getQueuePrefixKind', () => {
  it('identifies default prefixes', () => {
    expect(getQueuePrefixKind('__wkf_workflow_')).toBe('workflow');
    expect(getQueuePrefixKind('__wkf_step_')).toBe('step');
  });

  it('identifies namespaced prefixes', () => {
    expect(getQueuePrefixKind('__custom_wkf_workflow_')).toBe('workflow');
    expect(getQueuePrefixKind('__custom_wkf_step_')).toBe('step');
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

  it('accepts step queue names', () => {
    expect(ValidQueueName.parse('__wkf_step_myStep')).toBe('__wkf_step_myStep');
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
      kind: 'workflow',
      id: 'myFlow',
    });
  });

  it('parses namespaced workflow queue names', () => {
    expect(parseQueueName('__custom_wkf_workflow_myFlow')).toEqual({
      prefix: '__custom_wkf_workflow_',
      kind: 'workflow',
      id: 'myFlow',
    });
  });

  it('parses namespaced step queue names', () => {
    expect(parseQueueName('__custom_wkf_step_myStep')).toEqual({
      prefix: '__custom_wkf_step_',
      kind: 'step',
      id: 'myStep',
    });
  });
});
