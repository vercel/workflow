import { describe, expect, it } from 'vitest';
import {
  getSpanEntityName,
  getSpanTitle,
} from '../src/components/sidebar/span-name.js';

const STEP_NAME = 'step//./src/jobs/order//fetchData';
const WORKFLOW_NAME = 'workflow//./src/jobs/order//processOrder';

describe('getSpanEntityName', () => {
  it('prefers stepName over workflowName', () => {
    expect(
      getSpanEntityName({ stepName: STEP_NAME, workflowName: WORKFLOW_NAME })
    ).toBe(STEP_NAME);
  });

  it('falls back to workflowName', () => {
    expect(getSpanEntityName({ workflowName: WORKFLOW_NAME })).toBe(
      WORKFLOW_NAME
    );
  });

  it('ignores non-string and empty names', () => {
    expect(
      getSpanEntityName({ stepName: 42, workflowName: WORKFLOW_NAME })
    ).toBe(WORKFLOW_NAME);
    expect(getSpanEntityName({ stepName: '' })).toBeUndefined();
  });

  it('returns undefined without a record', () => {
    expect(getSpanEntityName(undefined)).toBeUndefined();
    expect(getSpanEntityName(null)).toBeUndefined();
    expect(getSpanEntityName('step')).toBeUndefined();
    expect(getSpanEntityName({ hookId: 'hook_1' })).toBeUndefined();
  });
});

describe('getSpanTitle', () => {
  it('uses the short name of a step', () => {
    expect(getSpanTitle({ stepName: STEP_NAME }, 'step')).toBe('fetchData');
  });

  it('uses the short name of a workflow', () => {
    expect(getSpanTitle({ workflowName: WORKFLOW_NAME }, 'run')).toBe(
      'processOrder'
    );
  });

  it('keeps a name it cannot parse', () => {
    expect(getSpanTitle({ stepName: 'legacy-step' }, 'step')).toBe(
      'legacy-step'
    );
  });

  it('names a hook by its token, then its id', () => {
    expect(getSpanTitle({ hookId: 'hook_1', token: 'tok_1' }, 'hook')).toBe(
      'tok_1'
    );
    expect(getSpanTitle({ hookId: 'hook_1' }, 'hook')).toBe('hook_1');
  });

  it('falls back to the hook id for other resources', () => {
    expect(getSpanTitle({ hookId: 'hook_1' }, 'sleep')).toBe('hook_1');
  });

  it('falls back to "Details"', () => {
    expect(getSpanTitle(undefined)).toBe('Details');
    expect(getSpanTitle({ waitId: 'wait_1' }, 'sleep')).toBe('Details');
    expect(getSpanTitle({}, 'hook')).toBe('Details');
  });
});
