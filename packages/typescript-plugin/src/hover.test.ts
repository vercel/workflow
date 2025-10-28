import ts from 'typescript/lib/tsserverlibrary';
import { describe, expect, it } from 'vitest';
import { getHoverInfo } from './hover';
import { createTestProgram } from './test-helpers';

describe('getHoverInfo', () => {
  describe('Directive hover information', () => {
    it('provides hover info for "use workflow" directive', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          return 123;
        }
      `;

      const { program, sourceFile } = createTestProgram(source);
      const directivePos = sourceFile.text.indexOf("'use workflow'") + 1; // Position inside string

      const hoverInfo = getHoverInfo('test.ts', directivePos, program, ts);

      expect(hoverInfo).toBeDefined();
      expect(hoverInfo?.displayParts?.[0]?.text).toContain('Workflow');
      expect(hoverInfo?.documentation).toBeDefined();
      expect(hoverInfo?.documentation?.[0].text).toContain('use workflow');
      expect(hoverInfo?.documentation?.[0].text).toContain(
        'https://useworkflow.dev/docs'
      );
    });

    it('provides hover info for "use step" directive', () => {
      const source = `
        export async function myStep() {
          'use step';
          return 'hello';
        }
      `;

      const { program, sourceFile } = createTestProgram(source);
      const directivePos = sourceFile.text.indexOf("'use step'") + 1;

      const hoverInfo = getHoverInfo('test.ts', directivePos, program, ts);

      expect(hoverInfo).toBeDefined();
      expect(hoverInfo?.displayParts?.[0]?.text).toContain('Step');
      expect(hoverInfo?.documentation?.[0].text).toContain('use step');
    });

    it('includes documentation URL in hover info', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          return 123;
        }
      `;

      const { program, sourceFile } = createTestProgram(source);
      const directivePos = sourceFile.text.indexOf("'use workflow'") + 1;

      const hoverInfo = getHoverInfo('test.ts', directivePos, program, ts);

      expect(hoverInfo?.documentation?.[0].text).toContain(
        'https://useworkflow.dev/docs/foundations/workflows-and-steps#workflow-functions'
      );
    });
  });

  describe('Non-directive hover', () => {
    it('returns undefined for non-directive strings', () => {
      const source = `
        const myString = 'hello world';
        export async function myFunc() {
          'use workflow';
          return 123;
        }
      `;

      const { program, sourceFile } = createTestProgram(source);
      const stringPos = sourceFile.text.indexOf("'hello world'") + 1;

      const hoverInfo = getHoverInfo('test.ts', stringPos, program, ts);

      expect(hoverInfo).toBeUndefined();
    });

    it('returns undefined for directives not in function body', () => {
      const source = `
        const dir = 'use workflow';
      `;

      const { program, sourceFile } = createTestProgram(source);
      const stringPos = sourceFile.text.indexOf("'use workflow'") + 1;

      const hoverInfo = getHoverInfo('test.ts', stringPos, program, ts);

      expect(hoverInfo).toBeUndefined();
    });

    it('returns undefined when directive is not the first statement', () => {
      const source = `
        export async function myWorkflow() {
          const x = 1;
          'use workflow';
          return x;
        }
      `;

      const { program, sourceFile } = createTestProgram(source);
      const stringPos = sourceFile.text.indexOf("'use workflow'") + 1;

      const hoverInfo = getHoverInfo('test.ts', stringPos, program, ts);

      expect(hoverInfo).toBeUndefined();
    });
  });
});
