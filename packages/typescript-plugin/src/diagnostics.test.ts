import ts from 'typescript/lib/tsserverlibrary';
import { describe, expect, it } from 'vitest';
import { getCustomDiagnostics } from './diagnostics';
import {
  createTestProgram,
  expectDiagnostic,
  expectNoDiagnostic,
} from './test-helpers';

describe('getCustomDiagnostics', () => {
  describe('Error 9001: Workflow function must be async', () => {
    it('warns when workflow function is not async', () => {
      const source = `
        export function myWorkflow() {
          'use workflow';
          return 123;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9001,
        messageIncludes: 'async',
      });
    });

    it('warns when workflow function does not return Promise', () => {
      const source = `
        export function myWorkflow(): number {
          'use workflow';
          return 123;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9001,
        messageIncludes: 'Promise',
      });
    });

    it('does not warn when workflow function is async', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          return 123;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectNoDiagnostic(diagnostics, 9001);
    });

    it('does not warn when workflow function returns Promise', () => {
      const source = `
        export function myWorkflow(): Promise<number> {
          'use workflow';
          return Promise.resolve(123);
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectNoDiagnostic(diagnostics, 9001);
    });
  });

  describe('Error 9002: Step function must be async', () => {
    it('warns when step function is not async', () => {
      const source = `
        function myStep() {
          'use step';
          return 'hello';
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9002,
        messageIncludes: 'async',
      });
    });

    it('does not warn when step function is async', () => {
      const source = `
        async function myStep() {
          'use step';
          return 'hello';
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectNoDiagnostic(diagnostics, 9002);
    });
  });

  describe('Error 9003: Node.js API usage in workflows', () => {
    it('warns when using fs with default import', () => {
      const source = `
        import fs from 'fs';

        export async function myWorkflow() {
          'use workflow';
          const data = fs.readFileSync('/tmp/test.txt', 'utf-8');
          return data;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9003,
        messageIncludes: 'fs',
      });
    });

    it('warns when using fs with named import', () => {
      const source = `
        import { readFileSync } from 'fs';

        export async function myWorkflow() {
          'use workflow';
          const data = readFileSync('/tmp/test.txt', 'utf-8');
          return data;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9003,
        messageIncludes: 'fs',
      });
    });

    it('warns when using node: prefix imports', () => {
      const source = `
        import { readFileSync } from 'node:fs';

        export async function myWorkflow() {
          'use workflow';
          const data = readFileSync('/tmp/test.txt', 'utf-8');
          return data;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9003,
        messageIncludes: 'node:fs',
      });
    });

    it('warns for http module usage', () => {
      const source = `
        import http from 'http';

        export async function myWorkflow() {
          'use workflow';
          const server = http.createServer();
          return server;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9003,
        messageIncludes: 'http',
      });
    });

    it('does not warn when Node.js API used in step function', () => {
      const source = `
        import fs from 'fs';

        async function myStep() {
          'use step';
          const data = fs.readFileSync('/tmp/test.txt', 'utf-8');
          return data;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectNoDiagnostic(diagnostics, 9003);
    });

    it('does not warn when importing without using', () => {
      const source = `
        import fs from 'fs';

        export async function myWorkflow() {
          'use workflow';
          return 123;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectNoDiagnostic(diagnostics, 9003);
    });
  });

  describe('Error 9004: setTimeout/setInterval usage', () => {
    it('warns when using setTimeout in workflow', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          setTimeout(() => console.log('hello'), 1000);
          return 'done';
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9004,
        messageIncludes: 'sleep()',
      });
    });

    it('warns when using setInterval in workflow', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          setInterval(() => console.log('tick'), 1000);
          return 'done';
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9004,
        messageIncludes: 'sleep()',
      });
    });
  });

  describe('Error 9005: setImmediate usage', () => {
    it('warns when using setImmediate in workflow', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          setImmediate(() => console.log('immediate'));
          return 'done';
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9005,
        messageIncludes: 'setImmediate',
      });
    });
  });

  describe('Error 9006: Global fetch usage', () => {
    it('warns when using global fetch in workflow', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          const response = await fetch('https://api.example.com');
          return response.json();
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9006,
        messageIncludes: 'workflow',
      });
    });

    it('does not warn when using fetch from workflow', () => {
      const source = `
        import { fetch } from 'workflow';

        export async function myWorkflow() {
          'use workflow';
          const response = await fetch('https://api.example.com');
          return response.json();
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectNoDiagnostic(diagnostics, 9006);
    });
  });

  describe('Integration: Multiple diagnostics', () => {
    it('returns multiple diagnostics for multiple issues', () => {
      const source = `
        import fs from 'fs';

        export function badWorkflow() {
          'use workflow';
          const data = fs.readFileSync('/tmp/test.txt', 'utf-8');
          setTimeout(() => console.log('hello'), 1000);
          return data;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      // Should have: not async (9001), fs usage (9003), setTimeout (9004)
      expect(diagnostics.length).toBeGreaterThanOrEqual(3);
      expectDiagnostic(diagnostics, { code: 9001 });
      expectDiagnostic(diagnostics, { code: 9003 });
      expectDiagnostic(diagnostics, { code: 9004 });
    });
  });

  describe('Error 9007: use workflow in Next.js App Router route handler', () => {
    it('warns when using "use workflow" in exported GET function in route.ts', () => {
      const source = `
        export async function GET(req: Request) {
          'use workflow';
          return new Response('Hello');
        }
      `;

      const { program } = createTestProgram(source, 'app/api/test/route.ts');
      const diagnostics = getCustomDiagnostics(
        'app/api/test/route.ts',
        program,
        ts
      );

      expectDiagnostic(diagnostics, {
        code: 9007,
        messageIncludes: 'start()',
      });
    });

    it('warns when using "use workflow" in exported POST function in route.ts', () => {
      const source = `
        export async function POST(req: Request) {
          'use workflow';
          return new Response('Hello');
        }
      `;

      const { program } = createTestProgram(source, 'app/api/test/route.ts');
      const diagnostics = getCustomDiagnostics(
        'app/api/test/route.ts',
        program,
        ts
      );

      expectDiagnostic(diagnostics, {
        code: 9007,
        messageIncludes: 'Next.js App Router',
      });
    });

    it('warns for all HTTP methods (PUT, PATCH, DELETE, HEAD, OPTIONS)', () => {
      const methods = ['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

      for (const method of methods) {
        const source = `
          export async function ${method}(req: Request) {
            'use workflow';
            return new Response('Hello');
          }
        `;

        const { program } = createTestProgram(source, 'app/api/test/route.ts');
        const diagnostics = getCustomDiagnostics(
          'app/api/test/route.ts',
          program,
          ts
        );

        expectDiagnostic(diagnostics, {
          code: 9007,
        });
      }
    });

    it('does not warn when function is not exported', () => {
      const source = `
        async function GET(req: Request) {
          'use workflow';
          return new Response('Hello');
        }
      `;

      const { program } = createTestProgram(source, 'app/api/test/route.ts');
      const diagnostics = getCustomDiagnostics(
        'app/api/test/route.ts',
        program,
        ts
      );

      expectNoDiagnostic(diagnostics, 9007);
    });

    it('does not warn when file is not named route.ts', () => {
      const source = `
        export async function GET(req: Request) {
          'use workflow';
          return new Response('Hello');
        }
      `;

      const { program } = createTestProgram(source, 'api.ts');
      const diagnostics = getCustomDiagnostics('api.ts', program, ts);

      expectNoDiagnostic(diagnostics, 9007);
    });

    it('does not warn when function name is not an HTTP method', () => {
      const source = `
        export async function handler(req: Request) {
          'use workflow';
          return new Response('Hello');
        }
      `;

      const { program } = createTestProgram(source, 'app/api/test/route.ts');
      const diagnostics = getCustomDiagnostics(
        'app/api/test/route.ts',
        program,
        ts
      );

      expectNoDiagnostic(diagnostics, 9007);
    });

    it('works with route.tsx files', () => {
      const source = `
        export async function GET(req: Request) {
          'use workflow';
          return new Response('Hello');
        }
      `;

      const { program } = createTestProgram(source, 'app/api/test/route.tsx');
      const diagnostics = getCustomDiagnostics(
        'app/api/test/route.tsx',
        program,
        ts
      );

      expectDiagnostic(diagnostics, {
        code: 9007,
      });
    });

    it('warns when using arrow function syntax', () => {
      const source = `
        export const GET = async (req: Request) => {
          'use workflow';
          return new Response('Hello');
        };
      `;

      const { program } = createTestProgram(source, 'app/api/test/route.ts');
      const diagnostics = getCustomDiagnostics(
        'app/api/test/route.ts',
        program,
        ts
      );

      expectDiagnostic(diagnostics, {
        code: 9007,
        messageIncludes: 'start()',
      });
    });
  });

  describe('Edge cases', () => {
    it('does not error on empty file', () => {
      const source = '';

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expect(diagnostics).toEqual([]);
    });

    it('ignores functions without directives', () => {
      const source = `
        export function normalFunction() {
          return 123;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expect(diagnostics).toEqual([]);
    });

    it('handles arrow functions with directives', () => {
      const source = `
        export const myWorkflow = () => {
          'use workflow';
          return 123;
        };
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, { code: 9001 });
    });
  });

  describe('Error 9008: Misspelled directives', () => {
    it('warns when using "use workfow" instead of "use workflow"', () => {
      const source = `
        export async function myWorkflow() {
          'use workfow';
          return 123;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9008,
        messageIncludes: 'typo',
      });
    });

    it('warns when using "use workflw" instead of "use workflow"', () => {
      const source = `
        export async function myWorkflow() {
          'use workflw';
          return 123;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9008,
        messageIncludes: 'use workflow',
      });
    });

    it('warns when using "use ste" instead of "use step"', () => {
      const source = `
        export async function myStep() {
          'use ste';
          return 'hello';
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9008,
        messageIncludes: 'use step',
      });
    });

    it('warns when using "use step " (with space) instead of "use step"', () => {
      const source = `
        export async function myStep() {
          'use step ';
          return 'hello';
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9008,
      });
    });

    it('does not warn when directive is correct', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          return 123;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectNoDiagnostic(diagnostics, 9008);
    });

    it('does not warn for typos too different from directives', () => {
      const source = `
        export async function myFunc() {
          'hello world';
          return 123;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectNoDiagnostic(diagnostics, 9008);
    });
  });

  describe('Misspelled directive message formatting', () => {
    it('uses quotes for typo in message', () => {
      const source = `
        export async function myWorkflow() {
          'use workfow';
          return 123;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9008,
        messageIncludes: "'use workfow'",
      });
      expectDiagnostic(diagnostics, {
        code: 9008,
        messageIncludes: "'use workflow'",
      });
    });

    it('shows typo and correction in quotes', () => {
      const source = `
        export async function myWorkflow() {
          "use workflw";
          return 123;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9008,
        messageIncludes: "'use workflw'",
      });
      expectDiagnostic(diagnostics, {
        code: 9008,
        messageIncludes: "'use workflow'",
      });
    });
  });

  describe('Error 9009: Direct workflow function invocation', () => {
    it('warns when calling workflow function directly from another workflow', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          return 123;
        }

        export async function anotherWorkflow() {
          'use workflow';
          await myWorkflow();
          return 456;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9009,
        messageIncludes: 'start()',
      });
    });

    it('warns when calling workflow function directly from API route', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          return 123;
        }

        export async function POST(req: Request) {
          const result = await myWorkflow();
          return Response.json(result);
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9009,
        messageIncludes: 'start()',
      });
    });

    it('warns when calling workflow function directly from regular function', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          return 123;
        }

        export async function regularFunction() {
          const result = await myWorkflow();
          return result;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9009,
        messageIncludes: 'workflow/api',
      });
    });

    it('does not warn when using start() function to invoke workflow', () => {
      const source = `
        import { start } from 'workflow/api';

        export async function myWorkflow() {
          'use workflow';
          return 123;
        }

        export async function handler() {
          const run = await start(myWorkflow);
          return run;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectNoDiagnostic(diagnostics, 9009);
    });

    it('warns when invoking through await expression', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          return 'result';
        }

        export async function caller() {
          const x = await myWorkflow();
          return x;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9009,
      });
    });

    it('warns when invoking without await', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          return 'result';
        }

        export function caller() {
          myWorkflow();
          return 'done';
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9009,
      });
    });

    it('warns multiple times if workflow called multiple times', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          return 123;
        }

        export async function handler() {
          await myWorkflow();
          await myWorkflow();
          return 'done';
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      // Should have at least 2 warnings for the two calls
      const warnings = diagnostics.filter((d) => d.code === 9009);
      expect(warnings.length).toBeGreaterThanOrEqual(2);
    });

    it('does not warn when calling non-workflow functions', () => {
      const source = `
        export async function regularFunction() {
          return 123;
        }

        export async function caller() {
          const result = await regularFunction();
          return result;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectNoDiagnostic(diagnostics, 9009);
    });

    it('warns when calling workflow from Next.js Server Action', () => {
      const source = `
        'use server';

        export async function myWorkflow() {
          'use workflow';
          return 123;
        }

        export async function serverAction() {
          const result = await myWorkflow();
          return result;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9009,
        messageIncludes: 'start()',
      });
    });

    it('shows warning level (not error) for direct invocation', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          return 123;
        }

        export async function caller() {
          await myWorkflow();
          return 'done';
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      const warning = diagnostics.find((d) => d.code === 9009);
      expect(warning).toBeDefined();
      expect(warning?.category).toBe(ts.DiagnosticCategory.Warning);
    });

    it('warns when calling exported const arrow function with "use workflow"', () => {
      const source = `
        export const myWorkflow = async () => {
          'use workflow';
          return 123;
        };

        export async function caller() {
          const result = await myWorkflow();
          return result;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      expectDiagnostic(diagnostics, {
        code: 9009,
        messageIncludes: 'start()',
      });
    });

    it('detects nested workflow function calls - both outer and inner', () => {
      const source = `
        export async function wf1() {
          'use workflow';
          return 1;
        }

        export async function wf2() {
          'use workflow';
          return 2;
        }

        export async function caller() {
          const x = wf1(wf2());
          return x;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      // Should have warnings for BOTH wf1() and wf2() calls
      const warnings = diagnostics.filter((d) => d.code === 9009);
      expect(warnings.length).toBeGreaterThanOrEqual(2);
    });

    it('detects deeply nested workflow function calls', () => {
      const source = `
        export async function wf1() {
          'use workflow';
          return 1;
        }

        export async function wf2() {
          'use workflow';
          return 2;
        }

        export async function wf3() {
          'use workflow';
          return 3;
        }

        export async function caller() {
          const x = wf1(wf2(wf3()));
          return x;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      // Should have warnings for wf1(), wf2(), and wf3() calls
      const warnings = diagnostics.filter((d) => d.code === 9009);
      expect(warnings.length).toBeGreaterThanOrEqual(3);
    });

    it('detects multiple nested calls in different arguments', () => {
      const source = `
        export async function wf1() {
          'use workflow';
          return 1;
        }

        export async function wf2() {
          'use workflow';
          return 2;
        }

        export async function wf3() {
          'use workflow';
          return 3;
        }

        export async function caller() {
          const x = wf1(wf2(), wf3());
          return x;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      // Should have warnings for wf1(), wf2(), and wf3() calls
      const warnings = diagnostics.filter((d) => d.code === 9009);
      expect(warnings.length).toBeGreaterThanOrEqual(3);
    });

    it('detects nested calls in array literals', () => {
      const source = `
        export async function wf1() {
          'use workflow';
          return 1;
        }

        export async function wf2() {
          'use workflow';
          return 2;
        }

        export async function caller() {
          const arr = [wf1(), wf2()];
          return arr;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      // Should have warnings for both wf1() and wf2() calls
      const warnings = diagnostics.filter((d) => d.code === 9009);
      expect(warnings.length).toBeGreaterThanOrEqual(2);
    });

    it('detects nested calls in object properties', () => {
      const source = `
        export async function wf1() {
          'use workflow';
          return 1;
        }

        export async function wf2() {
          'use workflow';
          return 2;
        }

        export async function caller() {
          const obj = { a: wf1(), b: wf2() };
          return obj;
        }
      `;

      const { program } = createTestProgram(source);
      const diagnostics = getCustomDiagnostics('test.ts', program, ts);

      // Should have warnings for both wf1() and wf2() calls
      const warnings = diagnostics.filter((d) => d.code === 9009);
      expect(warnings.length).toBeGreaterThanOrEqual(2);
    });
  });
});
