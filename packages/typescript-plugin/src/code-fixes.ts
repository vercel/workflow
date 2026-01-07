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

  // Handle typo errors (code 9008) and direct workflow invocation (code 9009)
  if (errorCode === 9008) {
    return getDirectiveTypoFix(fileName, start, end, program, ts);
  } else if (errorCode === 9009) {
    return getDirectWorkflowInvocationFix(fileName, start, end, program, ts);
  }

  return fixes;
}

function getDirectiveTypoFix(
  fileName: string,
  start: number,
  end: number,
  program: Program,
  ts: TypeScriptLib
): CodeFixAction[] {
  const fixes: CodeFixAction[] = [];
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
    description: `Replace with '${expectedDirective}'`,
    changes: [change],
  });

  return fixes;
}

function getDirectWorkflowInvocationFix(
  fileName: string,
  start: number,
  end: number,
  program: Program,
  ts: TypeScriptLib
): CodeFixAction[] {
  const fixes: CodeFixAction[] = [];
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) {
    return fixes;
  }

  // Find the call expression at the error position
  let callExpr: any;

  function visit(node: Node) {
    if (
      ts.isCallExpression(node) &&
      node.getStart(sourceFile) >= start &&
      node.getEnd() <= end
    ) {
      callExpr = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (!callExpr || !ts.isCallExpression(callExpr)) {
    return fixes;
  }

  // Get the function name
  let functionName = '';
  if (ts.isIdentifier(callExpr.expression)) {
    functionName = callExpr.expression.text;
  } else {
    return fixes; // Can't fix property access calls yet
  }

  const sourceText = sourceFile.text;
  const changes: FileTextChanges[] = [];

  // Step 1: Check if start is already imported
  let startImportExists = false;
  const importNodes: any[] = [];

  function findImports(node: Node) {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (
        ts.isStringLiteral(moduleSpecifier) &&
        moduleSpecifier.text === 'workflow/api'
      ) {
        // Check if start is imported
        if (
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings)
        ) {
          const elements = node.importClause.namedBindings.elements;
          for (const elem of elements) {
            if (
              elem.name &&
              ts.isIdentifier(elem.name) &&
              elem.name.text === 'start'
            ) {
              startImportExists = true;
              return;
            }
          }
        }
      }
      importNodes.push(node);
    }
    ts.forEachChild(node, findImports);
  }

  findImports(sourceFile);

  // Step 2: Get the arguments
  const args = callExpr.arguments;
  let argsText = '';
  if (args.length > 0) {
    const firstArgStart = args[0].getStart(sourceFile);
    const lastArgEnd = args[args.length - 1].getEnd();
    argsText = sourceText.substring(firstArgStart, lastArgEnd);
  }

  // Step 3: Create the replacement for the call
  const newCallText = `start(${functionName}, [${argsText}])`;

  // Main change: replace the call expression
  const callStart = callExpr.expression.getStart(sourceFile);
  const callEnd = callExpr.getEnd();

  const textChanges = [
    {
      span: {
        start: callStart,
        length: callEnd - callStart,
      },
      newText: newCallText,
    },
  ];

  // Step 4: Add import if needed
  if (!startImportExists) {
    // Find the first import statement
    let insertAfter = 0;
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        insertAfter = statement.getEnd();
      } else if (!ts.isImportDeclaration(statement)) {
        break;
      }
    }

    // If no imports, insert at the beginning
    if (insertAfter === 0) {
      insertAfter = sourceFile.getStart();
    } else {
      insertAfter += 1; // After the newline
    }

    // Insert the import statement
    textChanges.push({
      span: {
        start: insertAfter,
        length: 0,
      },
      newText: `import { start } from 'workflow/api';\n`,
    });
  }

  changes.push({
    fileName,
    textChanges,
  });

  fixes.push({
    fixName: 'use-workflow-start-function',
    description: `Use start() from 'workflow/api' to invoke this workflow`,
    changes,
  });

  return fixes;
}
