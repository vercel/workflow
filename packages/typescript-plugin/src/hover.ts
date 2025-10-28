import type { Program, QuickInfo } from 'typescript/lib/tsserverlibrary';
import { getDirective } from './utils';

type TypeScriptLib = typeof import('typescript/lib/tsserverlibrary');

export function getHoverInfo(
  fileName: string,
  position: number,
  program: Program,
  ts: TypeScriptLib
): QuickInfo | undefined {
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) {
    return undefined;
  }

  // Find the node at the hover position
  let directiveNode:
    | import('typescript/lib/tsserverlibrary').StringLiteral
    | undefined;

  function visit(node: import('typescript/lib/tsserverlibrary').Node) {
    if (
      ts.isStringLiteral(node) &&
      node.getStart(sourceFile) <= position &&
      node.getEnd() >= position
    ) {
      directiveNode = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (!directiveNode) {
    return undefined;
  }

  const text = directiveNode.text;

  // Check if this is a directive
  if (text !== 'use workflow' && text !== 'use step') {
    return undefined;
  }

  // Check if this string is the first statement in a function body
  const parent = directiveNode.parent;
  if (!parent || !ts.isExpressionStatement(parent)) {
    return undefined;
  }

  const grandParent = parent.parent;
  if (!grandParent || !ts.isBlock(grandParent)) {
    return undefined;
  }

  const blockParent = grandParent.parent;
  if (
    !blockParent ||
    !(
      ts.isFunctionDeclaration(blockParent) ||
      ts.isArrowFunction(blockParent) ||
      ts.isFunctionExpression(blockParent)
    )
  ) {
    return undefined;
  }

  // Make sure this is the first statement
  if (grandParent.statements[0] !== parent) {
    return undefined;
  }

  // Get the parent function to determine directive type
  const directive = getDirective(blockParent, sourceFile, ts);
  if (!directive) {
    return undefined;
  }

  const isWorkflow = directive === 'use workflow';
  const docUrl = isWorkflow
    ? 'https://useworkflow.dev/docs/foundations/workflows-and-steps#workflow-functions'
    : 'https://useworkflow.dev/docs/foundations/workflows-and-steps#step-functions';
  const directiveType = isWorkflow ? 'Workflow' : 'Step';

  return {
    kind: ts.ScriptElementKind.constElement,
    kindModifiers: '',
    textSpan: {
      start: directiveNode.getStart(sourceFile),
      length: directiveNode.getWidth(sourceFile),
    },
    displayParts: [
      {
        text: `Workflow DevKit - ${directiveType} Function`,
        kind: 'text',
      },
    ],
    documentation: [
      {
        text: `[Learn more](${docUrl}) about the \`"${directive}"\` directive.`,
        kind: 'text',
      },
    ],
  };
}
