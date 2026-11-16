import type * as TS from 'typescript';

/**
 * AST helpers shared by the codemods. (The Inngest transform keeps its own
 * copies of these for now.)
 */

export type FunctionLike = TS.ArrowFunction | TS.FunctionExpression;

export function sortImports(a: string, b: string): number {
  const key = (s: string) => s.replace(/^type /, '').toLowerCase();
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
}

export function isExpressionList(
  target: unknown
): target is readonly TS.Expression[] {
  return Array.isArray(target);
}

export function isFunctionLike(
  ts: typeof TS,
  node: TS.Node | undefined
): node is FunctionLike {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

export function skipParens(ts: typeof TS, node: TS.Expression): TS.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

export function hasModifier(
  ts: typeof TS,
  node: TS.Node,
  kind: TS.SyntaxKind
): boolean {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  return !!modifiers?.some((m) => m.kind === kind);
}

export function enclosingFunction(
  ts: typeof TS,
  node: TS.Node
): TS.Node | undefined {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current) || ts.isClassStaticBlockDeclaration(current))
      return current;
    current = current.parent;
  }
  return undefined;
}

export function findAncestor<T extends TS.Node>(
  ts: typeof TS,
  node: TS.Node,
  test: (n: TS.Node) => n is T
): T | undefined {
  let current: TS.Node | undefined = node;
  while (current) {
    if (test(current)) return current;
    current = current.parent;
  }
  void ts;
  return undefined;
}

export function propertyNameText(
  ts: typeof TS,
  name: TS.PropertyName | TS.BindingName
): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  )
    return name.text;
  if (ts.isPrivateIdentifier?.(name)) return undefined;
  return undefined;
}

export function getProperty(
  ts: typeof TS,
  object: TS.ObjectLiteralExpression,
  key: string
): TS.Expression | undefined {
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      propertyNameText(ts, property.name) === key
    ) {
      return property.initializer;
    }
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === key
    ) {
      return property.name;
    }
  }
  return undefined;
}

export function literalText(
  ts: typeof TS,
  node: TS.Expression
): string | undefined {
  const expr = skipParens(ts, node);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
    return expr.text;
  return undefined;
}

export function firstDeclaration(
  symbol: TS.Symbol
): TS.Declaration | undefined {
  return symbol.valueDeclaration ?? symbol.declarations?.[0];
}

export function rootIdentifier(
  ts: typeof TS,
  node: TS.Expression
): TS.Identifier | undefined {
  let current = node;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current : undefined;
}

export function isSimpleReference(ts: typeof TS, node: TS.Expression): boolean {
  if (ts.isIdentifier(node)) return true;
  return (
    ts.isPropertyAccessExpression(node) &&
    isSimpleReference(ts, node.expression)
  );
}

export function isTypeOnlyDeclaration(ts: typeof TS, node: TS.Node): boolean {
  return (
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeParameterDeclaration(node)
  );
}

export function isFunctionOrClassDeclaration(
  ts: typeof TS,
  node: TS.Node
): boolean {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
    return true;
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const init = skipParens(ts, node.initializer);
    return (
      ts.isArrowFunction(init) ||
      ts.isFunctionExpression(init) ||
      ts.isClassExpression(init)
    );
  }
  return false;
}

export function isInsideParameter(ts: typeof TS, node: TS.Node): boolean {
  let current: TS.Node | undefined = node;
  while (current && !ts.isFunctionLike(current)) {
    if (ts.isParameter(current)) return true;
    current = current.parent;
  }
  return false;
}

export function inTypePosition(ts: typeof TS, node: TS.Node): boolean {
  let current: TS.Node | undefined = node.parent;
  while (current) {
    if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current))
      return true;
    if (ts.isExpression(current) || ts.isStatement(current)) return false;
    current = current.parent;
  }
  return false;
}

/** Whether an `a - 1` expression replacing `node` needs parentheses. */
export function needsParens(ts: typeof TS, node: TS.Node): boolean {
  const parent = node.parent;
  if (!parent) return true;
  // Contexts that take any expression (below the comma operator).
  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.arguments?.includes(node as TS.Expression)
  ) {
    return false;
  }
  if (ts.isArrayLiteralExpression(parent) || ts.isTemplateSpan(parent))
    return false;
  if (
    (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
    parent.initializer === node
  ) {
    return false;
  }
  if (ts.isReturnStatement(parent) || ts.isExpressionStatement(parent))
    return false;
  if (ts.isConditionalExpression(parent) && parent.condition !== node)
    return false;
  // Operators that bind looser than `-`.
  if (ts.isBinaryExpression(parent)) {
    const loose = [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.LessThanToken,
      ts.SyntaxKind.GreaterThanToken,
      ts.SyntaxKind.LessThanEqualsToken,
      ts.SyntaxKind.GreaterThanEqualsToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ];
    return !loose.includes(parent.operatorToken.kind);
  }
  return true;
}

/** Identifiers that introduce a binding (variable, function, class, import, parameter). */
export function isDeclarationName(ts: typeof TS, node: TS.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isParameter(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isBindingElement(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent) && parent.name === node) return true;
  return false;
}

/** Identifiers that name a property, label or member rather than a binding. */
export function isNonReferenceName(
  ts: typeof TS,
  node: TS.Identifier
): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node)
    return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if (ts.isMethodSignature(parent) && parent.name === node) return true;
  if (
    (ts.isGetAccessor(parent) || ts.isSetAccessor(parent)) &&
    parent.name === node
  )
    return true;
  if (ts.isEnumMember(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent))
    return true;
  if (ts.isJsxAttribute(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  if (ts.isMetaProperty(parent)) return true;
  return false;
}

/** Whether `node` is written to (`x = 1`, `x++`, `[x] = ...`, `for (x of ...)`). */
export function isAssignmentTarget(ts: typeof TS, node: TS.Node): boolean {
  let current: TS.Node = node;
  let parent = current.parent;
  while (parent) {
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      current = parent;
      parent = current.parent;
      continue;
    }
    if (
      (ts.isPrefixUnaryExpression(parent) ||
        ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      return true;
    }
    if (ts.isBinaryExpression(parent) && parent.left === current) {
      const op = parent.operatorToken.kind;
      return (
        op >= ts.SyntaxKind.FirstAssignment &&
        op <= ts.SyntaxKind.LastAssignment
      );
    }
    if (
      ts.isShorthandPropertyAssignment(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent)
    ) {
      // Part of a destructuring assignment only if the literal is a target.
      if (ts.isPropertyAssignment(parent) && parent.name === current)
        return false;
      current = parent;
      parent = current.parent;
      continue;
    }
    if (
      (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
      parent.initializer === current
    ) {
      return true;
    }
    return false;
  }
  return false;
}

/** `x.prop = ...` or `x[i] = ...` on a captured binding. */
export function isMutatedProperty(ts: typeof TS, node: TS.Node): boolean {
  let current: TS.Node = node;
  while (
    current.parent &&
    (ts.isPropertyAccessExpression(current.parent) ||
      ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  if (current === node) return false;
  return isAssignmentTarget(ts, current);
}

export function singleLine(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max
    ? `${collapsed.slice(0, max - 3)}...`
    : collapsed;
}

export function escapeTemplate(text: string): string {
  return text.replace(/[`\\]/g, '\\$&').replace(/\$\{/g, '\\${');
}

/** Normalize a rendered body: drop blank edges, indent a one-line body. */
export function trimRendered(rendered: string, indent: string): string {
  const lines = rendered.split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) return '';
  if (!/^[ \t]/.test(lines[0])) lines[0] = indent + lines[0];
  else if (!lines[0].startsWith(indent))
    lines[0] = indent + lines[0].trimStart();
  return lines.map((l) => l.replace(/[ \t]+$/, '')).join('\n');
}

export function detectQuote(sf: TS.SourceFile): string {
  const text = sf.text;
  const single =
    (text.match(/from '/g) ?? []).length + (text.match(/'use /g) ?? []).length;
  const double =
    (text.match(/from "/g) ?? []).length + (text.match(/"use /g) ?? []).length;
  return double > single ? '"' : "'";
}

export function detectSemicolons(sf: TS.SourceFile): boolean {
  let withSemi = 0;
  let without = 0;
  for (const statement of sf.statements.slice(0, 30)) {
    const t = statement.getText(sf);
    if (t.endsWith(';')) withSemi++;
    else if (!t.endsWith('}')) without++;
  }
  return withSemi >= without;
}
