type TypeScriptLib = typeof import('typescript/lib/tsserverlibrary');
type FunctionLikeDeclaration =
  import('typescript/lib/tsserverlibrary').FunctionLikeDeclaration;
type SourceFile = import('typescript/lib/tsserverlibrary').SourceFile;
type TypeChecker = import('typescript/lib/tsserverlibrary').TypeChecker;
type Node = import('typescript/lib/tsserverlibrary').Node;
type CallExpression = import('typescript/lib/tsserverlibrary').CallExpression;

/**
 * Checks if a function has a "use workflow" or "use step" directive
 */
export function getDirective(
  node: FunctionLikeDeclaration,
  _sourceFile: SourceFile,
  ts: TypeScriptLib
): 'use workflow' | 'use step' | null {
  if (!node.body || !ts.isBlock(node.body)) {
    return null;
  }

  const firstStatement = node.body.statements[0];
  if (!firstStatement || !ts.isExpressionStatement(firstStatement)) {
    return null;
  }

  const expression = firstStatement.expression;
  if (!ts.isStringLiteral(expression)) {
    return null;
  }

  const text = expression.text;
  if (text === 'use workflow' || text === 'use step') {
    return text;
  }

  return null;
}

/**
 * Workflow hooks available from @workflow/core
 */
export const WORKFLOW_HOOKS = [
  'getWorkflowMetadata',
  'getStepMetadata',
  'getWritable',
];

/**
 * Check if a function is async
 */
export function isAsyncFunction(
  node: FunctionLikeDeclaration,
  typeChecker: TypeChecker,
  ts: TypeScriptLib
): boolean {
  // Check for async keyword
  if (node.modifiers) {
    for (const mod of node.modifiers) {
      if (mod && mod.kind === ts.SyntaxKind.AsyncKeyword) {
        return true;
      }
    }
  }

  // Check if return type is Promise
  try {
    const signature = typeChecker.getSignatureFromDeclaration(node);
    if (signature) {
      const returnType = typeChecker.getReturnTypeOfSignature(signature);
      const typeString = typeChecker.typeToString(returnType);
      return typeString.startsWith('Promise<');
    }
  } catch {
    // If type checking fails, assume it's not async
    return false;
  }

  return false;
}

/**
 * Find all function calls within a node
 */
export function findFunctionCalls(
  node: Node,
  _sourceFile: SourceFile,
  tsLib: TypeScriptLib
): CallExpression[] {
  const calls: CallExpression[] = [];

  function visit(node: Node) {
    if (tsLib.isCallExpression(node)) {
      calls.push(node);
    }
    tsLib.forEachChild(node, visit);
  }

  visit(node);
  return calls;
}
