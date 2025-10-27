import ts from 'typescript/lib/tsserverlibrary';
import { describe, expect, it } from 'vitest';
import { getCodeFixes } from './code-fixes';
import { createTestProgram } from './test-helpers';

describe('getCodeFixes', () => {
  describe('Code 9008: Directive typo fixes', () => {
    it('provides a fix for "use workfow" typo', () => {
      const source = `
        export async function myWorkflow() {
          'use workfow';
          return 123;
        }
      `;

      const { program, sourceFile } = createTestProgram(source);

      // Find the position of 'use workfow'
      const typoStart = sourceFile.text.indexOf("'use workfow'");
      const typoEnd = typoStart + "'use workfow'".length;

      const fixes = getCodeFixes(
        'test.ts',
        typoStart,
        typoEnd,
        9008,
        program,
        ts
      );

      expect(fixes.length).toBe(1);
      expect(fixes[0].description).toContain('use workflow');
      expect(fixes[0].fixName).toBe('fix-directive-typo');
    });

    it('provides a fix for "use ste" typo', () => {
      const source = `
        export async function myStep() {
          'use ste';
          return 'hello';
        }
      `;

      const { program, sourceFile } = createTestProgram(source);

      const typoStart = sourceFile.text.indexOf("'use ste'");
      const typoEnd = typoStart + "'use ste'".length;

      const fixes = getCodeFixes(
        'test.ts',
        typoStart,
        typoEnd,
        9008,
        program,
        ts
      );

      expect(fixes.length).toBe(1);
      expect(fixes[0].description).toContain('use step');
    });

    it('replaces typo with correct directive preserving quotes', () => {
      const source = `
        export async function myWorkflow() {
          'use workflw';
          return 123;
        }
      `;

      const { program, sourceFile } = createTestProgram(source);

      const typoStart = sourceFile.text.indexOf("'use workflw'");
      const typoEnd = typoStart + "'use workflw'".length;

      const fixes = getCodeFixes(
        'test.ts',
        typoStart,
        typoEnd,
        9008,
        program,
        ts
      );

      expect(fixes.length).toBe(1);
      const change = fixes[0].changes[0].textChanges[0];
      expect(change.newText).toBe("'use workflow'");
    });

    it('works with double quotes', () => {
      const source = `
        export async function myStep() {
          "use ste";
          return 'hello';
        }
      `;

      const { program, sourceFile } = createTestProgram(source);

      const typoStart = sourceFile.text.indexOf('"use ste"');
      const typoEnd = typoStart + '"use ste"'.length;

      const fixes = getCodeFixes(
        'test.ts',
        typoStart,
        typoEnd,
        9008,
        program,
        ts
      );

      expect(fixes.length).toBe(1);
      const change = fixes[0].changes[0].textChanges[0];
      expect(change.newText).toBe('"use step"');
    });
  });

  describe('Non-typo error codes', () => {
    it('does not provide fixes for other error codes', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          return 123;
        }
      `;

      const { program } = createTestProgram(source);

      const start = 0;
      const end = 10;

      // Try code 9001 (not a typo)
      const fixes = getCodeFixes('test.ts', start, end, 9001, program, ts);

      expect(fixes.length).toBe(0);
    });
  });

  describe('Edge cases', () => {
    it('does not crash on invalid position', () => {
      const source = `
        export async function myWorkflow() {
          'use workflow';
          return 123;
        }
      `;

      const { program } = createTestProgram(source);

      const fixes = getCodeFixes('test.ts', 999999, 999999, 9008, program, ts);

      expect(fixes.length).toBe(0);
    });
  });
});
