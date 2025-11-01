import type {
  CodeFixAction,
  FileTextChanges,
  Node,
  Program,
} from 'typescript/lib/tsserverlibrary';
import { getDirectiveTypo } from './utils';

type TypeScriptLib = typeof import('typescript/lib/tsserverlibrary');

export function getCodeFixes(
  fileName: string,
  start: number,
  end: number,
  errorCode: number,
  program: Program,
  ts: TypeScriptLib
): CodeFixAction[] {
  const fixes: CodeFixAction[] = [];

  // Only provide fixes for typo errors (code 9008)
  if (errorCode !== 9008) {
    return fixes;
  }

  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) {
    return fixes;
  }

  // Find the string literal at the error position
  let stringNode: Node | undefined;

  function visit(node: Node) {
    if (
      ts.isStringLiteral(node) &&
      node.getStart(sourceFile) <= start &&
      node.getEnd() >= end
    ) {
      stringNode = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (!stringNode || !ts.isStringLiteral(stringNode)) {
    return fixes;
  }

  const typoText = stringNode.text;
  const expectedDirective = getDirectiveTypo(typoText);

  if (!expectedDirective) {
    return fixes;
  }

  // Get the quote character from the source
  const sourceText = sourceFile.text;
  const nodeStart = stringNode.getStart(sourceFile);
  const quoteChar = sourceText[nodeStart];

  // Create a fix that replaces the typo with the correct directive
  const change: FileTextChanges = {
    fileName,
    textChanges: [
      {
        span: {
          start: nodeStart,
          length: stringNode.getWidth(sourceFile),
        },
        newText: `${quoteChar}${expectedDirective}${quoteChar}`,
      },
    ],
  };

  fixes.push({
    fixName: 'fix-directive-typo',
    fixId: 'workflow--fix-directive-typo',
    description: `Replace with '${expectedDirective}'`,
    changes: [change],
  });

  return fixes;
}
