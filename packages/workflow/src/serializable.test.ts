import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('exports the same Serializable type through the public package entrypoints', () => {
  const fileName = fileURLToPath(
    new URL('./serializable-consumer.mts', import.meta.url)
  );
  const source = `
    import type { Serializable as CoreSerializable } from '@workflow/core';
    import type { Serializable } from 'workflow';

    declare const core: CoreSerializable;
    declare const workflow: Serializable;
    const fromCore: Serializable = core;
    const fromWorkflow: CoreSerializable = workflow;
    const nested: Serializable = { bytes: new Uint8Array([1, 2]), children: [null, new Date()] };

    // @ts-expect-error Symbols are outside the existing Serializable type.
    const symbol: Serializable = Symbol();
  `;
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (
    name,
    languageVersion,
    onError,
    shouldCreateNewSourceFile
  ) => {
    if (name === fileName) {
      return ts.createSourceFile(name, source, languageVersion);
    }
    return getSourceFile(
      name,
      languageVersion,
      onError,
      shouldCreateNewSourceFile
    );
  };
  const program = ts.createProgram([fileName], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: host.getCurrentDirectory,
      getNewLine: () => '\n',
    })
  ).toBe('');
});
