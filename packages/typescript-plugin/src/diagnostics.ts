import {
  findFunctionCalls,
  getDirective,
  getDirectiveTypo,
  isAsyncFunction,
  isDirectiveFunctionLike,
} from './utils';

const BUILTIN_MODULES = new Set<string>();

// Get built-in modules from Node.js `module.builtinModules`
// https://nodejs.org/api/module.html#modulebuiltinmodules
for (const mod of require('node:module').builtinModules as string[]) {
  // Add both unprefixed and 'node:' prefixed variants to the set of builtin modules
  BUILTIN_MODULES.add(mod);
  if (!mod.startsWith('node:')) {
    BUILTIN_MODULES.add(`node:${mod}`);
  }
}

function isBuiltinModule(moduleName: string): boolean {
  return BUILTIN_MODULES.has(moduleName);
}

function isBunModule(moduleName: string): boolean {
  return moduleName === 'bun' || moduleName.startsWith('bun:');
}

type TypeScriptLib = typeof import('typescript/lib/tsserverlibrary');
type Program = import('typescript/lib/tsserverlibrary').Program;
type Diagnostic = import('typescript/lib/tsserverlibrary').Diagnostic;
type Node = import('typescript/lib/tsserverlibrary').Node;
type FunctionLikeDeclaration =
  import('typescript/lib/tsserverlibrary').FunctionLikeDeclaration;
type CallExpression = import('typescript/lib/tsserverlibrary').CallExpression;

export function getCustomDiagnostics(
  fileName: string,
  program: Program,
  ts: TypeScriptLib
): Diagnostic[] {
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) {
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  const typeChecker = program.getTypeChecker();

  // Track function declarations with "use workflow" directive
  const workflowFunctions = new Set<string>();

  function addTypoError(node: Node, typo: string, expected: string) {
    const formattedTypo = `'${typo}'`;
    const formattedCorrect = `'${expected}'`;

    diagnostics.push({
      file: sourceFile,
      start: node.getStart(sourceFile),
      length: node.getWidth(sourceFile),
      messageText: `${formattedTypo} looks like a typo. Did you mean ${formattedCorrect}?`,
      category: ts.DiagnosticCategory.Error,
      code: 9008,
    });
  }

  function checkDirectiveStringLiteral(node: Node) {
    if (!ts.isStringLiteral(node)) {
      return;
    }

    const parent = node.parent;
    if (
      !parent ||
      !ts.isExpressionStatement(parent) ||
      !parent.parent ||
      !ts.isBlock(parent.parent)
    ) {
      return;
    }

    const block = parent.parent;
    const blockParent = block.parent;

    // Check if this is the first statement in a function body
    const isFunctionBody =
      isDirectiveFunctionLike(blockParent, ts) &&
      block.statements[0] === parent;

    if (!isFunctionBody) {
      return;
    }

    const directiveTypo = getDirectiveTypo(node.text);
    if (directiveTypo) {
      addTypoError(node, node.text, directiveTypo);
    }
  }

  function visit(node: Node) {
    // Check for misspelled directives in string literals at the start of functions
    checkDirectiveStringLiteral(node);

    // Check function declarations for workflow/step directives
    if (isDirectiveFunctionLike(node, ts)) {
      const directive = getDirective(node, ts);

      if (directive === 'use workflow') {
        checkWorkflowFunction(node);
        // Track workflow functions by name (for function declarations)
        if (ts.isFunctionDeclaration(node) && node.name) {
          workflowFunctions.add(node.name.text);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  function checkWorkflowFunction(node: FunctionLikeDeclaration) {
    // Check if this is a Next.js App Router route handler
    if (isNextJsRouteHandler(node)) {
      const start = node.getStart(sourceFile);
      const length = node.getWidth(sourceFile);
      diagnostics.push({
        file: sourceFile,
        start,
        length,
        messageText:
          '"use workflow" does not work in Next.js App Router route handlers. Extract the logic into a separate function with the `"use workflow"` directive, then use the `start()` function from `workflow/api` to invoke that workflow from within your route handler.',
        category: ts.DiagnosticCategory.Error,
        code: 9007,
      });
      return;
    }

    // Ensure it's async
    if (!isAsyncFunction(node, typeChecker, ts)) {
      const start = node.getStart(sourceFile);
      const length = node.getWidth(sourceFile);
      diagnostics.push({
        file: sourceFile,
        start,
        length,
        messageText: 'Workflow functions must be async or return a Promise',
        category: ts.DiagnosticCategory.Error,
        code: 9001,
      });
    }

    // Check for disallowed API usage
    if (node.body) {
      const calls = findFunctionCalls(node.body, sourceFile, ts);
      for (const call of calls) {
        checkDisallowedApiUsage(call);
      }
    }
  }

  function isNextJsRouteHandler(node: FunctionLikeDeclaration): boolean {
    // Check if file is named route.ts or route.js
    const isRouteFile = /\/route\.(ts|tsx|js|jsx)$/.test(fileName);
    if (!isRouteFile) {
      return false;
    }

    let functionName: string | null = null;
    let isExported = false;

    // For function declarations: export async function GET() {}
    if (ts.isFunctionDeclaration(node)) {
      isExported =
        node.modifiers?.some(
          (mod) => mod.kind === ts.SyntaxKind.ExportKeyword
        ) ?? false;
      functionName =
        node.name && ts.isIdentifier(node.name) ? node.name.text : null;
    }
    // For arrow functions: export const GET = async () => {}
    else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      // Check if this is assigned to a variable declaration
      const parent = node.parent;
      if (parent && ts.isVariableDeclaration(parent)) {
        // Get the variable name
        if (ts.isIdentifier(parent.name)) {
          functionName = parent.name.text;
        }

        // Check if the variable statement is exported
        const variableStatement = parent.parent?.parent;
        if (variableStatement && ts.isVariableStatement(variableStatement)) {
          isExported =
            variableStatement.modifiers?.some(
              (mod) => mod.kind === ts.SyntaxKind.ExportKeyword
            ) ?? false;
        }
      }
    }

    if (!isExported || !functionName) {
      return false;
    }

    // Check if function name is an HTTP method
    const httpMethods = [
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'HEAD',
      'OPTIONS',
    ];

    return httpMethods.includes(functionName);
  }

  function checkDisallowedApiUsage(call: CallExpression) {
    try {
      // Check for timer functions (setTimeout, setInterval, setImmediate)
      if (ts.isIdentifier(call.expression)) {
        const functionName = call.expression.text;

        if (functionName === 'setTimeout' || functionName === 'setInterval') {
          diagnostics.push({
            file: sourceFile,
            start: call.getStart(),
            length: call.getWidth(),
            messageText: `${functionName} is not available in workflow functions. Use 'sleep()' from workflow instead.`,
            category: ts.DiagnosticCategory.Error,
            code: 9004,
          });
          return;
        }

        if (functionName === 'setImmediate') {
          diagnostics.push({
            file: sourceFile,
            start: call.getStart(),
            length: call.getWidth(),
            messageText: `setImmediate is not available in workflow functions. Consider restructuring your code or moving this logic to a step function with "use step".`,
            category: ts.DiagnosticCategory.Error,
            code: 9005,
          });
          return;
        }

        // Check for global fetch - suggest using the one from workflow
        if (functionName === 'fetch') {
          const symbol = typeChecker.getSymbolAtLocation(call.expression);

          // Check if this is the global fetch (no import) or not from workflow
          if (symbol) {
            const declarations = symbol.getDeclarations();

            if (declarations && declarations.length > 0) {
              const decl = declarations[0];

              // If it's an import, check if it's from workflow
              if (
                ts.isImportSpecifier(decl) ||
                ts.isImportClause(decl) ||
                ts.isNamespaceImport(decl)
              ) {
                let importDecl:
                  | import('typescript/lib/tsserverlibrary').ImportDeclaration
                  | undefined;
                if (ts.isImportClause(decl)) {
                  importDecl =
                    decl.parent as import('typescript/lib/tsserverlibrary').ImportDeclaration;
                } else if (ts.isImportSpecifier(decl)) {
                  importDecl = decl.parent?.parent
                    ?.parent as import('typescript/lib/tsserverlibrary').ImportDeclaration;
                } else if (ts.isNamespaceImport(decl)) {
                  importDecl = decl.parent
                    ?.parent as import('typescript/lib/tsserverlibrary').ImportDeclaration;
                }

                if (
                  importDecl?.moduleSpecifier &&
                  ts.isStringLiteral(importDecl.moduleSpecifier)
                ) {
                  const moduleName = importDecl.moduleSpecifier.text;

                  // If it's already from workflow, it's fine
                  if (moduleName === 'workflow') {
                    return;
                  }
                }
              }
            }
          }

          // If we get here, it's either global fetch or not from workflow
          diagnostics.push({
            file: sourceFile,
            start: call.getStart(),
            length: call.getWidth(),
            messageText: `Use the 'fetch' step from workflow instead of the global fetch in workflow functions.`,
            category: ts.DiagnosticCategory.Error,
            code: 9006,
          });
          return;
        }
      }

      // Case 1: Property access like fs.readFileSync()
      if (ts.isPropertyAccessExpression(call.expression)) {
        const objectSymbol = typeChecker.getSymbolAtLocation(
          call.expression.expression
        );
        checkSymbolForDisallowedModule(objectSymbol, call);
      }
      // Case 2: Direct identifier call like readFileSync() (from named import)
      else if (ts.isIdentifier(call.expression)) {
        const symbol = typeChecker.getSymbolAtLocation(call.expression);
        checkSymbolForDisallowedModule(symbol, call);
      }
    } catch (error) {
      // Silently fail - don't clutter the UI with internal errors
      console.log(
        `[workflow-plugin] Error in checkDisallowedApiUsage: ${error}`
      );
    }
  }

  function checkSymbolForDisallowedModule(
    symbol: import('typescript/lib/tsserverlibrary').Symbol | undefined,
    callNode: CallExpression
  ) {
    if (!symbol) {
      return;
    }

    const declarations = symbol.getDeclarations();
    if (!declarations || declarations.length === 0) {
      return;
    }

    for (const decl of declarations) {
      if (!decl) {
        continue;
      }

      // Check if it's an import declaration
      if (
        ts.isImportClause(decl) ||
        ts.isImportSpecifier(decl) ||
        ts.isNamespaceImport(decl)
      ) {
        // ImportClause: parent is ImportDeclaration
        // ImportSpecifier: parent is NamedImports, parent.parent is ImportClause, parent.parent.parent is ImportDeclaration
        // NamespaceImport: parent is ImportClause, parent.parent is ImportDeclaration
        let importDecl:
          | import('typescript/lib/tsserverlibrary').ImportDeclaration
          | undefined;
        if (ts.isImportClause(decl)) {
          importDecl =
            decl.parent as import('typescript/lib/tsserverlibrary').ImportDeclaration;
        } else if (ts.isImportSpecifier(decl)) {
          importDecl = decl.parent?.parent
            ?.parent as import('typescript/lib/tsserverlibrary').ImportDeclaration;
        } else if (ts.isNamespaceImport(decl)) {
          importDecl = decl.parent
            ?.parent as import('typescript/lib/tsserverlibrary').ImportDeclaration;
        }

        if (
          importDecl?.moduleSpecifier &&
          ts.isStringLiteral(importDecl.moduleSpecifier)
        ) {
          const moduleName = importDecl.moduleSpecifier.text;

          // Check if it's a disallowed Node.js or Bun module
          if (isBuiltinModule(moduleName) || isBunModule(moduleName)) {
            const moduleType = isBunModule(moduleName) ? 'Bun' : 'Node.js';
            diagnostics.push({
              file: sourceFile,
              start: callNode.getStart(),
              length: callNode.getWidth(),
              messageText: `${moduleType} API "${moduleName}" is not available in workflow functions. Consider moving this code to a step function with "use step".`,
              category: ts.DiagnosticCategory.Error,
              code: 9003,
            });
            return;
          }
        }
      }
    }
  }

  function addDirectWorkflowInvocationDiagnostic(node: CallExpression) {
    diagnostics.push({
      file: sourceFile,
      start: node.getStart(),
      length: node.getWidth(),
      messageText: `Workflow functions should not be invoked directly. Use the \`start()\` function from 'workflow/api' to invoke this workflow.`,
      category: ts.DiagnosticCategory.Warning,
      code: 9009,
    });
  }

  function declarationHasWorkflowDirective(decl: Node): boolean {
    if (isDirectiveFunctionLike(decl, ts)) {
      return getDirective(decl, ts) === 'use workflow';
    }

    if (
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      isDirectiveFunctionLike(decl.initializer, ts)
    ) {
      return getDirective(decl.initializer, ts) === 'use workflow';
    }

    return false;
  }

  function isDirectWorkflowInvocation(node: CallExpression): boolean {
    if (!ts.isIdentifier(node.expression)) {
      return false;
    }

    // First check: is it a locally-defined workflow function?
    if (workflowFunctions.has(node.expression.text)) {
      return true;
    }

    // Second check: is it an imported workflow function?
    let symbolToCheck = typeChecker.getSymbolAtLocation(node.expression);

    if (symbolToCheck?.flags & ts.SymbolFlags.Alias) {
      const aliasedSymbol = typeChecker.getAliasedSymbol(symbolToCheck);
      if (aliasedSymbol !== symbolToCheck) {
        symbolToCheck = aliasedSymbol;
      }
    }

    return (
      symbolToCheck?.getDeclarations()?.some(declarationHasWorkflowDirective) ??
      false
    );
  }

  // Second pass: check all calls in the file for direct workflow function invocations
  function checkAllCallsForDirectWorkflowInvocation(
    node: Node,
    allowDirectWorkflowInvocation = false
  ) {
    if (isDirectiveFunctionLike(node, ts)) {
      const directive = getDirective(node, ts);
      if (directive === 'use workflow') {
        allowDirectWorkflowInvocation = true;
      } else if (directive === 'use step') {
        allowDirectWorkflowInvocation = false;
      }
    }

    if (
      !allowDirectWorkflowInvocation &&
      ts.isCallExpression(node) &&
      isDirectWorkflowInvocation(node)
    ) {
      addDirectWorkflowInvocationDiagnostic(node);
    }

    ts.forEachChild(node, (child) =>
      checkAllCallsForDirectWorkflowInvocation(
        child,
        allowDirectWorkflowInvocation
      )
    );
  }

  visit(sourceFile);
  checkAllCallsForDirectWorkflowInvocation(sourceFile);
  return diagnostics;
}
