import { describe, expect, test } from 'vitest';
import {
  formatStepName,
  formatWorkflowName,
  parseClassName,
  parseStepName,
  parseWorkflowName,
  stepDisplayName,
  workflowDisplayName,
} from './parse-name';

describe('parseWorkflowName', () => {
  test('should parse a valid workflow name with relative path', () => {
    const result = parseWorkflowName(
      'workflow//./src/workflows/order//handleOrder'
    );
    expect(result).toEqual({
      shortName: 'handleOrder',
      moduleSpecifier: './src/workflows/order',
      functionName: 'handleOrder',
    });
  });

  test('should parse a valid workflow name with module specifier', () => {
    const result = parseWorkflowName('workflow//mypackage@1.0.0//handleOrder');
    expect(result).toEqual({
      shortName: 'handleOrder',
      moduleSpecifier: 'mypackage@1.0.0',
      functionName: 'handleOrder',
    });
  });

  test('should parse a valid workflow name with scoped module specifier', () => {
    const result = parseWorkflowName(
      'workflow//@myorg/tasks@2.0.0//processOrder'
    );
    expect(result).toEqual({
      shortName: 'processOrder',
      moduleSpecifier: '@myorg/tasks@2.0.0',
      functionName: 'processOrder',
    });
  });

  test('should parse workflow name with nested function names', () => {
    const result = parseWorkflowName(
      'workflow//./src/app//nested//function//name'
    );
    expect(result).toEqual({
      shortName: 'name',
      moduleSpecifier: './src/app',
      functionName: 'nested//function//name',
    });
  });

  test('should return null for invalid workflow names', () => {
    expect(parseWorkflowName('invalid')).toBeNull();
    expect(parseWorkflowName('workflow//')).toBeNull();
    expect(parseWorkflowName('step//path//fn')).toBeNull();
  });

  test('should handle workflow name with empty function name part', () => {
    // This is technically allowed by the parser, though not ideal
    const result = parseWorkflowName('workflow//./path//');
    expect(result).toEqual({
      shortName: '',
      moduleSpecifier: './path',
      functionName: '',
    });
  });

  test('should use module name for default exports with relative path', () => {
    const result = parseWorkflowName('workflow//./src/jobs/order//default');
    expect(result).toEqual({
      shortName: 'order',
      moduleSpecifier: './src/jobs/order',
      functionName: 'default',
    });
  });

  test('should use package name for default exports with module specifier', () => {
    const result = parseWorkflowName('workflow//mypackage@1.0.0//default');
    expect(result).toEqual({
      shortName: 'mypackage',
      moduleSpecifier: 'mypackage@1.0.0',
      functionName: 'default',
    });
  });

  test('should use package name for default exports with scoped module specifier', () => {
    const result = parseWorkflowName('workflow//@myorg/tasks@2.0.0//default');
    expect(result).toEqual({
      shortName: 'tasks',
      moduleSpecifier: '@myorg/tasks@2.0.0',
      functionName: 'default',
    });
  });
});

describe('parseStepName', () => {
  test('should parse a valid step name with relative path', () => {
    const result = parseStepName('step//./src/workflows/order//processOrder');
    expect(result).toEqual({
      shortName: 'processOrder',
      moduleSpecifier: './src/workflows/order',
      functionName: 'processOrder',
    });
  });

  test('should parse a valid step name with module specifier', () => {
    const result = parseStepName('step//mypackage@1.0.0//processOrder');
    expect(result).toEqual({
      shortName: 'processOrder',
      moduleSpecifier: 'mypackage@1.0.0',
      functionName: 'processOrder',
    });
  });

  test('should parse step name with nested path', () => {
    const result = parseStepName('step//./app/api/generate/route//handleStep');
    expect(result).toEqual({
      shortName: 'handleStep',
      moduleSpecifier: './app/api/generate/route',
      functionName: 'handleStep',
    });
  });

  test('should return null for invalid step names', () => {
    expect(parseStepName('invalid')).toBeNull();
    expect(parseStepName('step//')).toBeNull();
    expect(parseStepName('workflow//path//fn')).toBeNull();
  });

  test('should handle step name with empty function name part', () => {
    // This is technically allowed by the parser, though not ideal
    const result = parseStepName('step//./path//');
    expect(result).toEqual({
      shortName: '',
      moduleSpecifier: './path',
      functionName: '',
    });
  });

  test('should handle builtin step names', () => {
    const result = parseStepName('step//builtin//__builtin_fetch');
    expect(result).toEqual({
      shortName: '__builtin_fetch',
      moduleSpecifier: 'builtin',
      functionName: '__builtin_fetch',
    });
  });

  test('should parse nested step in workflow', () => {
    const result = parseStepName(
      'step//./src/jobs/order//processOrder/innerStep'
    );
    expect(result).toEqual({
      shortName: 'innerStep',
      moduleSpecifier: './src/jobs/order',
      functionName: 'processOrder/innerStep',
    });
  });

  test('should parse static method step', () => {
    const result = parseStepName(
      'step//./src/jobs/order//MyClass.staticMethod'
    );
    expect(result).toEqual({
      shortName: 'MyClass.staticMethod',
      moduleSpecifier: './src/jobs/order',
      functionName: 'MyClass.staticMethod',
    });
  });

  test('should parse instance method step', () => {
    const result = parseStepName(
      'step//./src/jobs/order//MyClass#instanceMethod'
    );
    expect(result).toEqual({
      shortName: 'MyClass#instanceMethod',
      moduleSpecifier: './src/jobs/order',
      functionName: 'MyClass#instanceMethod',
    });
  });
});

describe('parseClassName', () => {
  test('should parse a valid class ID with relative path', () => {
    const result = parseClassName('class//./src/models/point//Point');
    expect(result).toEqual({
      shortName: 'Point',
      moduleSpecifier: './src/models/point',
      functionName: 'Point',
    });
  });

  test('should parse a valid class ID with module specifier', () => {
    const result = parseClassName('class//point@0.0.1//Point');
    expect(result).toEqual({
      shortName: 'Point',
      moduleSpecifier: 'point@0.0.1',
      functionName: 'Point',
    });
  });

  test('should parse class ID with scoped module specifier', () => {
    const result = parseClassName('class//@myorg/models@1.2.3//UserData');
    expect(result).toEqual({
      shortName: 'UserData',
      moduleSpecifier: '@myorg/models@1.2.3',
      functionName: 'UserData',
    });
  });

  test('should parse class ID with nested path', () => {
    const result = parseClassName('class//./workflows/user-signup//UserData');
    expect(result).toEqual({
      shortName: 'UserData',
      moduleSpecifier: './workflows/user-signup',
      functionName: 'UserData',
    });
  });

  test('should return null for invalid class IDs', () => {
    expect(parseClassName('invalid')).toBeNull();
    expect(parseClassName('class//')).toBeNull();
    expect(parseClassName('step//path//fn')).toBeNull();
    expect(parseClassName('workflow//path//fn')).toBeNull();
  });
});

describe('formatStepName / formatWorkflowName', () => {
  test('renders a step with relative path as "shortName (moduleSpecifier)"', () => {
    expect(formatStepName('step//./workflows/1_simple//add')).toBe(
      'add (./workflows/1_simple)'
    );
  });

  test('renders a workflow with relative path the same way', () => {
    expect(formatWorkflowName('workflow//./workflows/1_simple//simple')).toBe(
      'simple (./workflows/1_simple)'
    );
  });

  test('renders a step with module specifier', () => {
    expect(formatStepName('step//@myorg/tasks@2.0.0//processOrder')).toBe(
      'processOrder (@myorg/tasks@2.0.0)'
    );
  });

  test('nested functions use the leaf name', () => {
    expect(
      formatStepName('step//./workflows/order//processOrder/innerStep')
    ).toBe('innerStep (./workflows/order)');
  });

  test('falls back to the raw name when the format is unrecognized', () => {
    // Never silently drop information — if parsing fails the caller still
    // gets something back that identifies the entity.
    expect(formatStepName('something-weird')).toBe('something-weird');
    expect(formatWorkflowName('step//wrong-tag//fn')).toBe(
      'step//wrong-tag//fn'
    );
  });
});

describe('workflowDisplayName / stepDisplayName', () => {
  test('returns the short name for raw machine names', () => {
    expect(
      workflowDisplayName('workflow//./src/jobs/order//processOrder')
    ).toBe('processOrder');
    expect(stepDisplayName('step//./src/jobs/order//chargeCard')).toBe(
      'chargeCard'
    );
  });

  test('returns the short name for module-specifier names', () => {
    expect(workflowDisplayName('workflow//@myorg/shared@1.2.3//sync')).toBe(
      'sync'
    );
  });

  test('recovers the function name from queue-sanitized names', () => {
    // `workflow//./src/jobs/order//processOrder` after the queue's
    // `replace(/[^A-Za-z0-9-_]/g, '-')` sanitization:
    expect(
      workflowDisplayName('workflow----src-jobs-order--processOrder')
    ).toBe('processOrder');
    expect(stepDisplayName('step----src-jobs-order--chargeCard')).toBe(
      'chargeCard'
    );
  });

  test('sanitized nested functions use the leaf name', () => {
    expect(
      stepDisplayName('step----src-jobs-order--processOrder-innerStep')
    ).toBe('innerStep');
  });

  test('sanitized default exports map to the module short name', () => {
    // `workflow//./src/jobs/order//default` after sanitization — mirror
    // parseName's default-export handling so the same workflow doesn't
    // display as `order` in workflow.start but `default` in
    // workflow.execute.
    expect(workflowDisplayName('workflow----src-jobs-order--default')).toBe(
      'order'
    );
    expect(stepDisplayName('step----src-jobs-order--default')).toBe('order');
    // `__default` survives sanitization (underscores are preserved).
    expect(workflowDisplayName('workflow----src-jobs-order--__default')).toBe(
      'order'
    );
  });

  test('sanitized names with `$` degrade to the trailing segment (best effort)', () => {
    // `$` is a valid JS identifier character but sanitizes to `-`, so
    // `process$Order` is indistinguishable from a nested function — the
    // best-effort recovery returns just `Order`. Accepted limitation.
    expect(stepDisplayName('step----src-jobs-order--process-Order')).toBe(
      'Order'
    );
  });

  test('falls back to the input when unrecognized', () => {
    expect(workflowDisplayName('my-plain-name')).toBe('my-plain-name');
    expect(stepDisplayName('workflow--wrong-tag--fn')).toBe(
      'workflow--wrong-tag--fn'
    );
  });
});
