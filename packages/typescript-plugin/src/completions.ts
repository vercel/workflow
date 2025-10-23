import ts from 'typescript/lib/tsserverlibrary';
import { getDirective, WORKFLOW_HOOKS } from './utils';

export function enhanceCompletions(
  fileName: string,
  position: number,
  prior: ts.WithMetadata<ts.CompletionInfo> | undefined,
  program: ts.Program,
  ts: typeof import('typescript/lib/tsserverlibrary')
): ts.WithMetadata<ts.CompletionInfo> | undefined {
  if (!prior) return prior;

  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) return prior;

  // Find the enclosing function
  const node = findNodeAtPosition(sourceFile, position);
  if (!node) return prior;

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
