import ts from 'typescript/lib/tsserverlibrary';
import { describe, expect, it } from 'vitest';
import { createTestProgram } from './test-helpers';
import { findFunctionCalls, getDirective, isAsyncFunction } from './utils';

describe('getDirective', () => {
  it('returns "use workflow" for workflow functions', () => {
    const source = `
      function myWorkflow() {
        'use workflow';
        return 123;
      }
    `;

    const { program, sourceFile } = createTestProgram(source);

    let result: string | null = null;
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node)) {
        result = getDirective(node, sourceFile, ts);
      }
    });

    expect(result).toBe('use workflow');
  });

  it('returns "use step" for step functions', () => {
    const source = `
      function myStep() {
        'use step';
        return 123;
      }
    `;

    const { program, sourceFile } = createTestProgram(source);

    let result: string | null = null;
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node)) {
        result = getDirective(node, sourceFile, ts);
      }
    });

    expect(result).toBe('use step');
  });

  it('returns null for functions without directives', () => {
    const source = `
      function normalFunction() {
        return 123;
      }
    `;

    const { program, sourceFile } = createTestProgram(source);

    let result: string | null = null;
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node)) {
        result = getDirective(node, sourceFile, ts);
      }
    });

    expect(result).toBeNull();
  });

  it('returns null for functions with other string literals', () => {
    const source = `
      function myFunction() {
        'use strict';
        return 123;
      }
    `;

    const { program, sourceFile } = createTestProgram(source);

    let result: string | null = null;
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node)) {
        result = getDirective(node, sourceFile, ts);
      }
    });

    expect(result).toBeNull();
  });

  it('handles arrow functions', () => {
    const source = `
      const myWorkflow = () => {
        'use workflow';
        return 123;
      };
    `;

    const { program, sourceFile } = createTestProgram(source);

    let result: string | null = null;
    function visit(node: ts.Node) {
      if (ts.isArrowFunction(node)) {
        result = getDirective(node, sourceFile, ts);
      }
      ts.forEachChild(node, visit);
    }
    ts.forEachChild(sourceFile, visit);

    expect(result).toBe('use workflow');
  });
});

describe('isAsyncFunction', () => {
  it('returns true for async functions', () => {
    const source = `
      async function myFunction() {
        return 123;
      }
    `;

    const { program, sourceFile } = createTestProgram(source);
    const typeChecker = program.getTypeChecker();

    let result: boolean | null = null;
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node)) {
        result = isAsyncFunction(node, typeChecker, ts);
      }
    });

    expect(result).toBe(true);
  });

  it('returns true for functions returning Promise', () => {
    const source = `
      function myFunction(): Promise<number> {
        return Promise.resolve(123);
      }
    `;

    const { program, sourceFile } = createTestProgram(source);
    const typeChecker = program.getTypeChecker();

    let result: boolean | null = null;
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node)) {
        result = isAsyncFunction(node, typeChecker, ts);
      }
    });

    expect(result).toBe(true);
  });

  it('returns false for non-async functions without Promise', () => {
    const source = `
      function myFunction() {
        return 123;
      }
    `;

    const { program, sourceFile } = createTestProgram(source);
    const typeChecker = program.getTypeChecker();

    let result: boolean | null = null;
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node)) {
        result = isAsyncFunction(node, typeChecker, ts);
      }
    });

    expect(result).toBe(false);
  });

  it('handles async arrow functions', () => {
    const source = `
      const myFunction = async () => {
        return 123;
      };
    `;

    const { program, sourceFile } = createTestProgram(source);
    const typeChecker = program.getTypeChecker();

    let result: boolean | null = null;
    function visit(node: ts.Node) {
      if (ts.isArrowFunction(node)) {
        result = isAsyncFunction(node, typeChecker, ts);
      }
      ts.forEachChild(node, visit);
    }
    ts.forEachChild(sourceFile, visit);

    expect(result).toBe(true);
  });
});

describe('findFunctionCalls', () => {
  it('finds all function calls in a function body', () => {
    const source = `
      function myFunction() {
        console.log('hello');
        Math.random();
        someOtherCall();
      }
    `;

    const { program, sourceFile } = createTestProgram(source);

    let calls: ts.CallExpression[] = [];
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node) && node.body) {
        calls = findFunctionCalls(node.body, sourceFile, ts);
      }
    });

    expect(calls.length).toBe(3);
  });

  it('finds nested function calls', () => {
    const source = `
      function myFunction() {
        if (true) {
          console.log(Math.random());
        }
      }
    `;

    const { program, sourceFile } = createTestProgram(source);

    let calls: ts.CallExpression[] = [];
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node) && node.body) {
        calls = findFunctionCalls(node.body, sourceFile, ts);
      }
    });

    // Should find both console.log and Math.random
    expect(calls.length).toBe(2);
  });

  it('returns empty array for functions without calls', () => {
    const source = `
      function myFunction() {
        const x = 123;
        return x;
      }
    `;

    const { program, sourceFile } = createTestProgram(source);

    let calls: ts.CallExpression[] = [];
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node) && node.body) {
        calls = findFunctionCalls(node.body, sourceFile, ts);
      }
    });

    expect(calls).toEqual([]);
  });
});
