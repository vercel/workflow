import { describe, expect, it } from 'vitest';
import type { WorkflowManifest } from './apply-swc-transform.js';
import { analyzeSerdeCompliance } from './serde-checker.js';

const classId = 'class//models.ts//GatewayLanguageModel';

function manifestFor(
  classes: Record<string, { classId: string }>
): WorkflowManifest {
  return {
    classes: {
      'models.ts': classes,
    },
  };
}

function registrationFor(className: string, registeredClassId: string): string {
  return `
    class ${className} {}
    (function(__wf_cls, __wf_id) {
      var __wf_sym = Symbol.for("workflow-class-registry");
      var __wf_reg =
        globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
      __wf_reg.set(__wf_id, __wf_cls);
    })(${className}, "${registeredClassId}");
  `;
}

describe('analyzeSerdeCompliance', () => {
  it('ignores manifest classes removed from the workflow bundle', () => {
    const result = analyzeSerdeCompliance({
      sourceCode: '',
      workflowCode: 'globalThis.__private_workflows = new Map();',
      manifest: manifestFor({
        GatewayLanguageModel: { classId },
      }),
    });

    expect(result.classes).toEqual([]);
    expect(result.hasSerdeClasses).toBe(false);
  });

  it('ignores removed classes mentioned only in an inline source map', () => {
    const sourceMap = encodeURIComponent(
      JSON.stringify({
        version: 3,
        sources: ['models.ts'],
        sourcesContent: ['class GatewayLanguageModel {}'],
        mappings: '',
      })
    );
    const result = analyzeSerdeCompliance({
      sourceCode: '',
      workflowCode: [
        'globalThis.__private_workflows = new Map();',
        `//${'#'} sourceMappingURL=data:application/json,${sourceMap}`,
      ].join('\n'),
      manifest: manifestFor({
        GatewayLanguageModel: { classId },
      }),
    });

    expect(result.classes).toEqual([]);
    expect(result.hasSerdeClasses).toBe(false);
  });

  it('warns when a surviving class has no registration', () => {
    const result = analyzeSerdeCompliance({
      sourceCode: '',
      workflowCode: 'var GatewayLanguageModel = class {};',
      manifest: manifestFor({
        GatewayLanguageModel: { classId },
      }),
    });

    expect(result.classes).toMatchObject([
      {
        className: 'GatewayLanguageModel',
        registered: false,
        compliant: false,
      },
    ]);
    expect(result.classes[0].issues).toContain(
      'No class registration IIFE was generated. Ensure WORKFLOW_SERIALIZE and WORKFLOW_DESERIALIZE are defined as static methods inside the class body using computed property syntax: static [WORKFLOW_SERIALIZE](...) { ... }'
    );
    expect(result.hasSerdeClasses).toBe(true);
  });

  it('checks registration for each surviving class', () => {
    const otherClassId = 'class//models.ts//OtherModel';
    const result = analyzeSerdeCompliance({
      sourceCode: '',
      workflowCode: `
        ${registrationFor('GatewayLanguageModel', classId)}
        var OtherModel = class {};
      `,
      manifest: manifestFor({
        GatewayLanguageModel: { classId },
        OtherModel: { classId: otherClassId },
      }),
    });

    expect(result.classes).toMatchObject([
      {
        className: 'GatewayLanguageModel',
        registered: true,
        compliant: true,
      },
      {
        className: 'OtherModel',
        registered: false,
        compliant: false,
      },
    ]);
  });
});
