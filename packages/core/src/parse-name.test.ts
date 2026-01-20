import { describe, expect, test } from 'vitest';
import { parseClassName, parseStepName, parseWorkflowName } from './parse-name';

describe('parseWorkflowName', () => {
  test('should parse a valid workflow name with Unix path', () => {
    const result = parseWorkflowName(
      'workflow//src/workflows/order.ts//handleOrder'
    );
    expect(result).toEqual({
      shortName: 'handleOrder',
      path: 'src/workflows/order.ts',
      functionName: 'handleOrder',
    });
  });

  test('should parse a valid workflow name with forward slashes (normalized Windows path)', () => {
    const result = parseWorkflowName(
      'workflow//app/api/generate/route.ts//handleOrder'
    );
    expect(result).toEqual({
      shortName: 'handleOrder',
      path: 'app/api/generate/route.ts',
      functionName: 'handleOrder',
    });
  });

  test('should parse workflow name from normalized Windows path with drive letter', () => {
    // After normalization: C:\dev\project\file.ts becomes C:/dev/project/file.ts
    const result = parseWorkflowName(
      'workflow//C:/dev/birthday-card-generator/app/api/generate/route.ts//handleOrder'
    );
    expect(result).toEqual({
      shortName: 'handleOrder',
      path: 'C:/dev/birthday-card-generator/app/api/generate/route.ts',
      functionName: 'handleOrder',
    });
  });

  test('should parse workflow name with nested function names', () => {
    const result = parseWorkflowName(
      'workflow//src/app.ts//nested//function//name'
    );
    expect(result).toEqual({
      shortName: 'name',
      path: 'src/app.ts',
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
    const result = parseWorkflowName('workflow//path//');
    expect(result).toEqual({
      shortName: '',
      path: 'path',
      functionName: '',
    });
  });

  test('should handle line number as function name', () => {
    const result = parseWorkflowName('workflow//src/index.ts//42');
    expect(result).toEqual({
      shortName: '42',
      path: 'src/index.ts',
      functionName: '42',
    });
  });
});

describe('parseStepName', () => {
  test('should parse a valid step name with Unix path', () => {
    const result = parseStepName('step//src/workflows/order.ts//processOrder');
    expect(result).toEqual({
      shortName: 'processOrder',
      path: 'src/workflows/order.ts',
      functionName: 'processOrder',
    });
  });

  test('should parse a valid step name with forward slashes (normalized Windows path)', () => {
    const result = parseStepName('step//app/api/generate/route.ts//handleStep');
    expect(result).toEqual({
      shortName: 'handleStep',
      path: 'app/api/generate/route.ts',
      functionName: 'handleStep',
    });
  });

  test('should parse step name from normalized Windows path with drive letter', () => {
    // After normalization: C:\dev\project\file.ts becomes C:/dev/project/file.ts
    const result = parseStepName(
      'step//C:/dev/birthday-card-generator/app/api/generate/route.ts//handleStep'
    );
    expect(result).toEqual({
      shortName: 'handleStep',
      path: 'C:/dev/birthday-card-generator/app/api/generate/route.ts',
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
    const result = parseStepName('step//path//');
    expect(result).toEqual({
      shortName: '',
      path: 'path',
      functionName: '',
    });
  });

  test('should handle builtin step names', () => {
    const result = parseStepName('step//builtin//__builtin_fetch');
    expect(result).toEqual({
      shortName: '__builtin_fetch',
      path: 'builtin',
      functionName: '__builtin_fetch',
    });
  });
});

describe('parseClassName', () => {
  test('should parse a valid class ID', () => {
    const result = parseClassName('class//src/models/point.ts//Point');
    expect(result).toEqual({
      shortName: 'Point',
      path: 'src/models/point.ts',
      functionName: 'Point',
    });
  });

  test('should parse class ID with nested path', () => {
    const result = parseClassName('class//workflows/user-signup.ts//UserData');
    expect(result).toEqual({
      shortName: 'UserData',
      path: 'workflows/user-signup.ts',
      functionName: 'UserData',
    });
  });

  test('should return null for invalid class IDs', () => {
    expect(parseClassName('invalid')).toBeNull();
    expect(parseClassName('class//')).toBeNull();
    expect(parseClassName('step//path//fn')).toBeNull();
    expect(parseClassName('workflow//path//fn')).toBeNull();
  });

  test('should handle class ID with Windows-style path', () => {
    const result = parseClassName(
      'class//C:/dev/project/models/config.ts//Config'
    );
    expect(result).toEqual({
      shortName: 'Config',
      path: 'C:/dev/project/models/config.ts',
      functionName: 'Config',
    });
  });
});
