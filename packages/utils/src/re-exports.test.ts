import { describe, expect, test } from 'vitest';
import { parseClassName, parseStepName, parseWorkflowName } from './index';

describe('re-exports from main index', () => {
  test('parseStepName is re-exported', () => {
    expect(typeof parseStepName).toBe('function');
    const result = parseStepName('step//./src/workflows/order//processOrder');
    expect(result?.shortName).toBe('processOrder');
  });

  test('parseWorkflowName is re-exported', () => {
    expect(typeof parseWorkflowName).toBe('function');
    const result = parseWorkflowName(
      'workflow//./src/workflows/pulse//pulseRemoteWorkflow'
    );
    expect(result?.shortName).toBe('pulseRemoteWorkflow');
  });

  test('parseClassName is re-exported', () => {
    expect(typeof parseClassName).toBe('function');
    const result = parseClassName('class//./src/models/point//Point');
    expect(result?.shortName).toBe('Point');
  });
});
