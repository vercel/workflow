import type * as TS from 'typescript';
import {
  type FunctionLike,
  firstDeclaration,
  inTypePosition,
  isAssignmentTarget,
  isExpressionList,
  isFunctionOrClassDeclaration,
  isInsideParameter,
  isMutatedProperty,
  isNonReferenceName,
  isTypeOnlyDeclaration,
} from './ast.js';
import type { CapturedVariable } from './report-types.js';

export interface Capture extends CapturedVariable {
  /** Expression passed at the call site. */
  argument: string;
}

export interface CaptureAnalysis {
  captured: Capture[];
  /** Reasons the closure cannot be lifted without changing behavior. */
  blockers: string[];
  /** Lifted, but worth a note. */
  warnings: string[];
}

export interface CaptureOptions {
  ts: typeof TS;
  sf: TS.SourceFile;
  checker: TS.TypeChecker;
  /** The closure, or expressions that will be evaluated inside the step. */
  target: FunctionLike | readonly TS.Expression[];
  /** The function whose locals are captured (the workflow handler). */
  scope: TS.Node;
  /** Subtrees the caller rewrites itself; their identifiers are not captures. */
  isHandled?: (node: TS.Node) => boolean;
  /**
   * Called for a binding declared in `scope`: return a blocker message, or
   * 'skip' to leave it out (for example the step tools).
   */
  classify?: (
    symbol: TS.Symbol,
    node: TS.Identifier
  ) => string | 'skip' | undefined;
  /** 1-based line of a node, for the report. */
  line: (node: TS.Node) => number;
}

/**
 * What a step body reads from the enclosing workflow function. A step
 * function only gets its arguments, so every binding the closure reads from
 * `scope` becomes a parameter. Bindings at module scope stay visible to a
 * module-level step and are not captured. Anything that cannot cross the
 * boundary by value (a write to a captured variable, a captured function,
 * `this` from the enclosing method) is a blocker.
 */
export function analyzeCaptures(options: CaptureOptions): CaptureAnalysis {
  const { ts, sf, checker, target, scope, line } = options;
  const result: CaptureAnalysis = { captured: [], blockers: [], warnings: [] };
  const roots: readonly TS.Node[] = isExpressionList(target)
    ? target
    : [target.body, ...target.parameters];
  const closure: TS.Node = isExpressionList(target) ? scope : target;
  const arrowLike = isExpressionList(target) || ts.isArrowFunction(target);
  const owns = (declaration: TS.Node) =>
    isExpressionList(target)
      ? roots.some((root) => inside(declaration, root))
      : inside(declaration, target);
  const seen = new Set<TS.Symbol>();

  const ownThisOrArguments = (node: TS.Node): boolean => {
    let current = node.parent;
    while (current && current !== closure) {
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isClassLike(current)
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  };

  const visit = (node: TS.Node): void => {
    if (options.isHandled?.(node)) return;
    if (
      arrowLike &&
      node.kind === ts.SyntaxKind.ThisKeyword &&
      !ownThisOrArguments(node)
    ) {
      result.blockers.push(
        'The step uses `this` from the enclosing method, which a module-level step function cannot see.'
      );
    }
    if (ts.isIdentifier(node)) handleIdentifier(node);
    ts.forEachChild(node, visit);
  };

  const handleIdentifier = (node: TS.Identifier): void => {
    if (isNonReferenceName(ts, node)) return;
    if (node.text === 'arguments' && arrowLike && !ownThisOrArguments(node)) {
      result.blockers.push(
        'The step uses `arguments` from the enclosing function.'
      );
      return;
    }
    const symbol =
      ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
    if (!symbol) return;
    const declaration = firstDeclaration(symbol);
    if (!declaration || declaration.getSourceFile() !== sf) return;
    if (owns(declaration)) return; // the step body's own local
    if (!inside(declaration, scope)) return; // module scope stays visible

    const classified = options.classify?.(symbol, node);
    if (classified === 'skip') return;
    if (classified) {
      result.blockers.push(classified);
      return;
    }
    if (isTypeOnlyDeclaration(ts, declaration)) {
      result.blockers.push(
        `The step uses the type \`${node.text}\`, declared inside the workflow. Move the type to module scope.`
      );
      return;
    }
    if (inTypePosition(ts, node)) return;
    if (isFunctionOrClassDeclaration(ts, declaration)) {
      result.blockers.push(
        `The step calls \`${node.text}\`, a function or class declared inside the workflow. Functions are not serializable step arguments: move \`${node.text}\` to module scope and run the codemod again.`
      );
      return;
    }
    if (isAssignmentTarget(ts, node)) {
      result.blockers.push(
        `The step assigns to \`${node.text}\`, declared outside it. Passed as an argument, the write would be lost: return the new value from the step instead.`
      );
      return;
    }
    if (isMutatedProperty(ts, node)) {
      result.warnings.push(
        `\`${node.text}\` is modified inside the step. Step arguments are copies, so the change is not visible to the workflow. Return the value instead.`
      );
    }
    if (seen.has(symbol)) return;
    seen.add(symbol);
    result.captured.push({
      name: node.text,
      argument: node.text,
      declaredAt: line(declaration),
      kind:
        ts.isParameter(declaration) || isInsideParameter(ts, declaration)
          ? 'parameter'
          : 'variable',
    });
  };

  roots.forEach(visit);
  result.blockers = [...new Set(result.blockers)];
  result.warnings = [...new Set(result.warnings)];
  return result;
}

function inside(node: TS.Node, container: TS.Node): boolean {
  return node.pos >= container.pos && node.end <= container.end;
}
