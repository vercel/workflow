import { describe, expect, it } from 'vitest';
import { replaceGeneratedRouteExport } from './request-converter.js';

describe('replaceGeneratedRouteExport', () => {
  it('replaces route code before an inline source map', () => {
    const result = replaceGeneratedRouteExport(
      'export const POST = handler;\n//# sourceMappingURL=data:application/json;base64,abc',
      /export const POST = handler;$/,
      'export const POST = wrappedHandler;',
      'not found'
    );

    expect(result).toBe(
      'export const POST = wrappedHandler;\n//# sourceMappingURL=data:application/json;base64,abc'
    );
  });

  it('ignores source map comments embedded before route exports', () => {
    const result = replaceGeneratedRouteExport(
      [
        'const workflowCode = `',
        '//# sourceMappingURL=data:application/json;base64,inner',
        '`;',
        'const handler = workflowEntrypoint(workflowCode);',
        'export const HEAD = handler;',
        'export const POST = handler;',
      ].join('\n'),
      /const handler = workflowEntrypoint\(workflowCode\);\s*export const HEAD = handler;\s*export const POST = handler;?\s*$/m,
      'export const POST = wrappedHandler;',
      'not found'
    );

    expect(result).toBe(
      [
        'const workflowCode = `',
        '//# sourceMappingURL=data:application/json;base64,inner',
        '`;',
        'export const POST = wrappedHandler;',
      ].join('\n')
    );
  });

  it('throws when the route export pattern is not found', () => {
    expect(() =>
      replaceGeneratedRouteExport(
        'export const GET = handler;',
        /export const POST = handler;$/,
        'export const POST = wrappedHandler;',
        'missing route export'
      )
    ).toThrow('missing route export');
  });
});
