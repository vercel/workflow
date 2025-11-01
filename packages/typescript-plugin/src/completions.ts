import ts from 'typescript/lib/tsserverlibrary';
import { getDirective, WORKFLOW_HOOKS } from './utils';

export function enhanceCompletions(
  fileName: string,
  position: number,
  prior: ts.WithMetadata<ts.CompletionInfo> | undefined,
  program: ts.Program,
  ts: typeof import('typescript/lib/tsserverlibrary')
): ts.WithMetadata<ts.CompletionInfo> | undefined {
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) return prior;

  // Find the enclosing function
  const node = findNodeAtPosition(sourceFile, position);

  if (!node) return prior;

  if (
    node.parent.getChildAt(0) === node &&
    node.kind === ts.SyntaxKind.StringLiteral
  ) {
    // return `"use workflow"` or `"use step"` completions
    return {
      ...prior,
      entries: [
        {
          name: '"use workflow"',
          kind: ts.ScriptElementKind.string,
          kindModifiers: '',
          sortText: '0',
          labelDetails: {
            description: 'Marks the function as a workflow',
          },
          source: 'Workflow Development Kit',
          insertText: '"use workflow";',
          replacementSpan: { start: node.getStart(), length: node.getWidth() },
          isRecommended: true,
        },
        {
          name: '"use step"',
          kind: ts.ScriptElementKind.string,
          kindModifiers: '',
          sortText: '0',
          insertText: '"use step";',
          labelDetails: {
            description: 'Marks the function as a step',
          },
          source: 'Workflow Development Kit',
          replacementSpan: { start: node.getStart(), length: node.getWidth() },
          isRecommended: true,
        },
        ...(prior ? prior.entries : []),
      ],
    };
  }

  if (!prior) return prior;

  const enclosingFunction = findEnclosingFunction(node);
  if (!enclosingFunction) return prior;

  const directive = getDirective(enclosingFunction, sourceFile, ts);

  // If we're in a workflow function, add workflow hooks to completions
  if (directive === 'use workflow') {
    const workflowCompletions: ts.CompletionEntry[] = WORKFLOW_HOOKS.map(
      (hookName) => ({
        name: hookName,
        kind: ts.ScriptElementKind.functionElement,
        kindModifiers: '',
        sortText: '0', // Sort to top
        insertText: hookName,
        isRecommended: true,
      })
    );

    return {
      ...prior,
      entries: [...workflowCompletions, ...prior.entries],
    };
  }

  return prior;
}

function findNodeAtPosition(
  sourceFile: ts.SourceFile,
  position: number
): ts.Node | undefined {
  function find(node: ts.Node): ts.Node | undefined {
    if (position >= node.getStart() && position < node.getEnd()) {
      return ts.forEachChild(node, find) || node;
    }
    return undefined;
  }
  return find(sourceFile);
}

function findEnclosingFunction(
  node: ts.Node
): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}
