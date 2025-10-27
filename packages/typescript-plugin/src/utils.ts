type TypeScriptLib = typeof import('typescript/lib/tsserverlibrary');
type FunctionLikeDeclaration =
  import('typescript/lib/tsserverlibrary').FunctionLikeDeclaration;
type SourceFile = import('typescript/lib/tsserverlibrary').SourceFile;
type TypeChecker = import('typescript/lib/tsserverlibrary').TypeChecker;
type Node = import('typescript/lib/tsserverlibrary').Node;
type CallExpression = import('typescript/lib/tsserverlibrary').CallExpression;

/**
 * Helper to compare characters and advance indices
 */
function advanceIndices(
  i: number,
  j: number,
  aLen: number,
  bLen: number
): [number, number] {
  if (aLen > bLen) {
    return [i + 1, j];
  }
  if (bLen > aLen) {
    return [i, j + 1];
  }
  return [i + 1, j + 1];
}

/**
 * Checks if a string is similar to a target string (detects typos)
 * Uses edit distance algorithm - allows up to 1 difference
 */
export function detectSimilarStrings(a: string, b: string): boolean {
  const aChars = a.split('');
  const bChars = b.split('');

  if (Math.abs(aChars.length - bChars.length) > 1) {
    return false;
  }

  let differences = 0;
  let i = 0;
  let j = 0;

  while (i < aChars.length && j < bChars.length) {
    if (aChars[i] !== bChars[j]) {
      differences += 1;
      if (differences > 1) {
        return false;
      }
      [i, j] = advanceIndices(i, j, aChars.length, bChars.length);
    } else {
      i += 1;
      j += 1;
    }
  }

  return differences + (aChars.length - i) + (bChars.length - j) === 1;
}

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
 * Checks if a string literal is a misspelled directive
 * Returns the expected directive if it's a typo, null otherwise
 */
export function getDirectiveTypo(
  text: string
): 'use workflow' | 'use step' | null {
  if (detectSimilarStrings(text, 'use workflow')) {
    return 'use workflow';
  }
  if (detectSimilarStrings(text, 'use step')) {
    return 'use step';
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
