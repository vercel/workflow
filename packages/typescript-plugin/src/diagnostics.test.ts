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
});
