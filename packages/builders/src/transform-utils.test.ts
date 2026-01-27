import { describe, expect, it } from 'vitest';
import {
  useStepPattern,
  useWorkflowPattern,
  workflowSerdeImportPattern,
  workflowSerdeSymbolPattern,
} from './transform-utils.js';

describe('transform-utils patterns', () => {
  describe('useWorkflowPattern', () => {
    it('should match "use workflow" with single quotes', () => {
      expect(useWorkflowPattern.test(`'use workflow';`)).toBe(true);
      expect(useWorkflowPattern.test(`'use workflow'`)).toBe(true);
    });

    it('should match "use workflow" with double quotes', () => {
      expect(useWorkflowPattern.test(`"use workflow";`)).toBe(true);
      expect(useWorkflowPattern.test(`"use workflow"`)).toBe(true);
    });

    it('should match with leading whitespace', () => {
      expect(useWorkflowPattern.test(`  'use workflow';`)).toBe(true);
      expect(useWorkflowPattern.test(`\t"use workflow";`)).toBe(true);
    });

    it('should not match inline usage', () => {
      expect(useWorkflowPattern.test(`const x = 'use workflow';`)).toBe(false);
    });
  });

  describe('useStepPattern', () => {
    it('should match "use step" with single quotes', () => {
      expect(useStepPattern.test(`'use step';`)).toBe(true);
      expect(useStepPattern.test(`'use step'`)).toBe(true);
    });

    it('should match "use step" with double quotes', () => {
      expect(useStepPattern.test(`"use step";`)).toBe(true);
      expect(useStepPattern.test(`"use step"`)).toBe(true);
    });
  });

  describe('workflowSerdeImportPattern', () => {
    it('should match import from @workflow/serde with single quotes', () => {
      const source = `import { WORKFLOW_SERIALIZE } from '@workflow/serde';`;
      expect(workflowSerdeImportPattern.test(source)).toBe(true);
    });

    it('should match import from @workflow/serde with double quotes', () => {
      const source = `import { WORKFLOW_SERIALIZE } from "@workflow/serde";`;
      expect(workflowSerdeImportPattern.test(source)).toBe(true);
    });

    it('should match import with multiple specifiers', () => {
      const source = `import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';`;
      expect(workflowSerdeImportPattern.test(source)).toBe(true);
    });

    it('should match import with type', () => {
      const source = `import type { SerializationSymbol } from '@workflow/serde';`;
      expect(workflowSerdeImportPattern.test(source)).toBe(true);
    });

    it('should not match similar but different packages', () => {
      expect(
        workflowSerdeImportPattern.test(`import { x } from '@other/serde';`)
      ).toBe(false);
      expect(
        workflowSerdeImportPattern.test(
          `import { x } from '@workflow/serde-utils';`
        )
      ).toBe(false);
    });
  });

  describe('workflowSerdeSymbolPattern', () => {
    it('should match Symbol.for with workflow-serialize', () => {
      const source = `static [Symbol.for('workflow-serialize')](instance) {}`;
      expect(workflowSerdeSymbolPattern.test(source)).toBe(true);
    });

    it('should match Symbol.for with workflow-deserialize', () => {
      const source = `static [Symbol.for('workflow-deserialize')](data) {}`;
      expect(workflowSerdeSymbolPattern.test(source)).toBe(true);
    });

    it('should match with double quotes', () => {
      const source = `static [Symbol.for("workflow-serialize")](instance) {}`;
      expect(workflowSerdeSymbolPattern.test(source)).toBe(true);
    });

    it('should match with whitespace variations', () => {
      expect(
        workflowSerdeSymbolPattern.test(`Symbol.for( 'workflow-serialize' )`)
      ).toBe(true);
      expect(
        workflowSerdeSymbolPattern.test(`Symbol.for('workflow-deserialize')`)
      ).toBe(true);
    });

    it('should match in a full class definition', () => {
      const source = `
        export class Point {
          constructor(x, y) {
            this.x = x;
            this.y = y;
          }

          static [Symbol.for('workflow-serialize')](instance) {
            return { x: instance.x, y: instance.y };
          }

          static [Symbol.for('workflow-deserialize')](data) {
            return new Point(data.x, data.y);
          }
        }
      `;
      expect(workflowSerdeSymbolPattern.test(source)).toBe(true);
    });

    it('should not match other Symbol.for usage', () => {
      expect(
        workflowSerdeSymbolPattern.test(`Symbol.for('other-symbol')`)
      ).toBe(false);
      expect(
        workflowSerdeSymbolPattern.test(`Symbol.for('workflow-something-else')`)
      ).toBe(false);
    });

    it('should not match non-Symbol.for patterns', () => {
      expect(workflowSerdeSymbolPattern.test(`'workflow-serialize'`)).toBe(
        false
      );
      expect(workflowSerdeSymbolPattern.test(`workflow-deserialize`)).toBe(
        false
      );
    });
  });

  describe('combined detection', () => {
    it('should detect file using imported symbols', () => {
      const source = `
        import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';

        export class MyClass {
          static [WORKFLOW_SERIALIZE](instance) {
            return { value: instance.value };
          }

          static [WORKFLOW_DESERIALIZE](data) {
            return new MyClass(data.value);
          }
        }
      `;
      expect(workflowSerdeImportPattern.test(source)).toBe(true);
      // Note: workflowSerdeSymbolPattern won't match here because the symbols
      // are referenced by identifier, not directly as Symbol.for()
      expect(workflowSerdeSymbolPattern.test(source)).toBe(false);
    });

    it('should detect file using direct Symbol.for', () => {
      const source = `
        export class Point {
          static [Symbol.for('workflow-serialize')](instance) {
            return { x: instance.x };
          }

          static [Symbol.for('workflow-deserialize')](data) {
            return new Point(data.x);
          }
        }
      `;
      expect(workflowSerdeImportPattern.test(source)).toBe(false);
      expect(workflowSerdeSymbolPattern.test(source)).toBe(true);
    });

    it('should detect file with both patterns', () => {
      // This would be unusual but valid
      const source = `
        import { WORKFLOW_SERIALIZE } from '@workflow/serde';

        export class Point {
          // Using imported symbol
          static [WORKFLOW_SERIALIZE](instance) {
            return { x: instance.x };
          }

          // Using direct Symbol.for
          static [Symbol.for('workflow-deserialize')](data) {
            return new Point(data.x);
          }
        }
      `;
      expect(workflowSerdeImportPattern.test(source)).toBe(true);
      expect(workflowSerdeSymbolPattern.test(source)).toBe(true);
    });
  });
});
