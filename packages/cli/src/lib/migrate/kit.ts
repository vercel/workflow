import type * as TS from 'typescript';
import { EditSet, indentAt, lineOf } from './edits.js';
import { TODO_TAG } from './markers.js';
import { NameAllocator } from './names.js';
import type { MigrationNote } from './report-types.js';

/**
 * Per-file plumbing a codemod needs around its own rewrites: source-preserving
 * edits, TODO comments above statements, Workflow SDK imports under aliases
 * that never collide with the file's bindings, and removal of imports whose
 * every use the codemod rewrote.
 */
export type WorkflowModule = 'workflow' | 'workflow/api' | 'workflow/errors';

export class FileKit {
  readonly text: string;
  readonly edits: EditSet;
  readonly names: NameAllocator;
  readonly quote: string;
  readonly semi: string;
  readonly indentUnit: string;
  readonly typed: boolean;
  /** Every identifier text in the file (for conservative name allocation). */
  readonly identifiers = new Set<string>();
  /** Binding name -> `module:name` (or `module:type:name`) when it is an import. */
  private readonly declared = new Map<string, string | undefined>();
  private readonly imports = new Map<WorkflowModule, Set<string>>();
  private readonly aliases = new Map<string, string>();
  private readonly todos = new Map<number, string[]>();
  private readonly helpers: Array<() => string> = [];
  /** Ranges whose original references are dropped, and the ones kept inside. */
  readonly dropped: Array<[number, number]> = [];
  readonly kept: Array<[number, number]> = [];
  changed = false;

  constructor(
    readonly ts: typeof TS,
    readonly sf: TS.SourceFile,
    readonly checker: TS.TypeChecker,
    typed: boolean,
    indentUnit: string
  ) {
    this.text = sf.text;
    this.edits = new EditSet(this.text);
    this.typed = typed;
    this.indentUnit = indentUnit;
    const collect = (node: TS.Node): void => {
      if (ts.isIdentifier(node)) {
        this.identifiers.add(node.text);
        if (isDeclarationName(ts, node)) {
          let from: string | undefined;
          const parent = node.parent;
          if (ts.isImportSpecifier(parent)) {
            const decl = parent.parent.parent.parent;
            if (
              ts.isImportDeclaration(decl) &&
              ts.isStringLiteral(decl.moduleSpecifier)
            ) {
              const typeOnly =
                parent.isTypeOnly || !!decl.importClause?.isTypeOnly;
              from = `${decl.moduleSpecifier.text}:${typeOnly ? 'type:' : ''}${(parent.propertyName ?? parent.name).text}`;
            }
          }
          this.declared.set(
            node.text,
            this.declared.has(node.text) ? undefined : from
          );
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);
    this.names = new NameAllocator(this.identifiers);
    this.quote = detectQuote(sf);
    this.semi = detectSemicolons(sf) ? ';' : '';
  }

  line(node: TS.Node | number): number {
    return lineOf(
      this.text,
      typeof node === 'number' ? node : node.getStart(this.sf)
    );
  }

  symbolOf(node: TS.Node): TS.Symbol | undefined {
    const symbol = this.checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & this.ts.SymbolFlags.Alias) {
      return symbol;
    }
    return symbol;
  }

  /** The symbol an import alias points to (or the symbol itself). */
  resolved(node: TS.Node): TS.Symbol | undefined {
    const symbol = this.checker.getSymbolAtLocation(node);
    if (!symbol) return undefined;
    if (symbol.flags & this.ts.SymbolFlags.Alias) {
      try {
        return this.checker.getAliasedSymbol(symbol);
      } catch {
        return symbol;
      }
    }
    return symbol;
  }

  /** Replace `[node.start, node.end)` and mark the original references dropped. */
  replace(
    node: TS.Node,
    render: string | (() => string),
    kept: TS.Node[] = []
  ): void {
    const start = node.getStart(this.sf);
    this.dropped.push([start, node.end]);
    for (const k of kept) this.kept.push([k.getStart(this.sf), k.end]);
    this.changed = true;
    this.edits.add(start, node.end, render);
  }

  /** Render a node with the edits inside it applied. */
  render(node: TS.Node): string {
    return this.edits.render(node.getStart(this.sf), node.end);
  }

  /** Remove a whole statement, with its line break. */
  removeStatement(statement: TS.Node): void {
    let start = statement.getStart(this.sf);
    // A statement alone on its line goes with its indentation.
    const lineBegin = this.text.lastIndexOf('\n', start - 1) + 1;
    if (/^[ \t]*$/.test(this.text.slice(lineBegin, start))) start = lineBegin;
    let end = statement.end;
    if (this.text[end] === '\n') end++;
    else if (this.text.slice(end, end + 2) === '\r\n') end += 2;
    // A statement on its own between blank lines takes one blank line along.
    const lineStart = start;
    const blankBefore =
      /^[ \t]*$/.test(
        this.text.slice(lineStart, statement.getStart(this.sf))
      ) && this.text.slice(Math.max(0, lineStart - 2), lineStart) === '\n\n';
    if (blankBefore && /^[ \t]*\n/.test(this.text.slice(end))) {
      end = this.text.indexOf('\n', end) + 1;
    }
    this.dropped.push([start, end]);
    this.changed = true;
    this.edits.add(start, end, '');
  }

  /** Statement (in a statement list) that contains `node`. */
  statementOf(node: TS.Node): TS.Statement | undefined {
    const ts = this.ts;
    let current: TS.Node | undefined = node;
    while (current) {
      const parent: TS.Node | undefined = current.parent;
      if (
        parent &&
        (ts.isBlock(parent) ||
          ts.isSourceFile(parent) ||
          ts.isCaseClause(parent) ||
          ts.isDefaultClause(parent) ||
          ts.isModuleBlock(parent)) &&
        ts.isStatement(current)
      ) {
        return current;
      }
      current = parent;
    }
    return undefined;
  }

  /** Leave `node` in place with a TODO comment above its statement. */
  todo(node: TS.Node, message: string, notes: MigrationNote[]): void {
    notes.push({ severity: 'todo', line: this.line(node), message });
    const statement = this.statementOf(node);
    if (!statement) return;
    const pos = statement.getStart(this.sf);
    const list = this.todos.get(pos) ?? [];
    if (!list.includes(message)) list.push(message);
    this.todos.set(pos, list);
  }

  /**
   * Forget a binding the codemod is removing (an import every use of which
   * it rewrites), so `use()` can give its name to the replacement.
   */
  release(name: string): void {
    this.declared.delete(name);
  }

  /** Local name for `name` imported from `module`; registers the import. */
  use(module: WorkflowModule, name: string, preferred = name): string {
    const key = `${module}:${name}`;
    const known = this.aliases.get(key);
    if (known) return known;
    const taken = (candidate: string) =>
      (this.declared.has(candidate) && this.declared.get(candidate) !== key) ||
      (candidate !== name && this.identifiers.has(candidate));
    let local = preferred;
    if (taken(local)) {
      const base =
        preferred !== name
          ? preferred
          : `workflow${name[0].toUpperCase()}${name.slice(1)}`;
      local = base;
      for (let n = 2; taken(local) || this.declared.has(local); n++) {
        local = `${base}${n}`;
      }
    }
    this.names.reserve(local);
    this.aliases.set(key, local);
    if (this.declared.get(local) !== key) {
      this.importSet(module).add(local === name ? name : `${name} as ${local}`);
    }
    return local;
  }

  /** A type-only import from `workflow` (TypeScript files only). */
  useType(name: string): string {
    const key = `workflow:type:${name}`;
    const known = this.aliases.get(key);
    if (known) return known;
    const imported = (candidate: string) =>
      this.declared.get(candidate) === `workflow:${name}` ||
      this.declared.get(candidate) === `workflow:type:${name}`;
    let local = name;
    for (let n = 2; this.declared.has(local) && !imported(local); n++) {
      local = `Workflow${name}${n}`;
    }
    this.names.reserve(local);
    this.aliases.set(key, local);
    if (!imported(local)) {
      this.importSet('workflow').add(
        local === name ? `type ${name}` : `type ${name} as ${local}`
      );
    }
    return local;
  }

  /** Add an import of `names` from a relative module (e.g. activities). */
  addModuleImport(module: string, specifiers: string[]): void {
    const key = module as WorkflowModule;
    for (const s of specifiers) this.importSet(key).add(s);
  }

  /** Append a module-level helper to the end of the file. */
  helper(render: () => string): void {
    this.helpers.push(render);
  }

  private importSet(module: WorkflowModule): Set<string> {
    let set = this.imports.get(module);
    if (!set) {
      set = new Set();
      this.imports.set(module, set);
    }
    return set;
  }

  isDropped(pos: number, end: number): boolean {
    let innermost: { kind: 'drop' | 'keep'; size: number } | undefined;
    for (const [s, e] of this.dropped) {
      if (pos >= s && end <= e && (!innermost || e - s <= innermost.size))
        innermost = { kind: 'drop', size: e - s };
    }
    for (const [s, e] of this.kept) {
      if (pos >= s && end <= e && (!innermost || e - s < innermost.size))
        innermost = { kind: 'keep', size: e - s };
    }
    return innermost?.kind === 'drop';
  }

  /** References to `symbol`, and how many survive the edits. */
  references(
    symbol: TS.Symbol,
    declaration: TS.Node
  ): { total: number; live: number } {
    const ts = this.ts;
    const count = { total: 0, live: 0 };
    const visit = (node: TS.Node): void => {
      if (
        ts.isIdentifier(node) &&
        node !== declaration &&
        !isNonReferenceName(ts, node)
      ) {
        const s =
          ts.isShorthandPropertyAssignment(node.parent) &&
          node.parent.name === node
            ? this.checker.getShorthandAssignmentValueSymbol(node.parent)
            : this.checker.getSymbolAtLocation(node);
        if (s === symbol) {
          count.total++;
          if (!this.isDropped(node.getStart(this.sf), node.end)) count.live++;
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const statement of this.sf.statements) {
      if (!ts.isImportDeclaration(statement)) visit(statement);
    }
    return count;
  }

  /**
   * Finish the file: TODO comments, helpers, import cleanup and the new
   * imports. Returns the new text, or the original when nothing changed.
   */
  finish(): string {
    const ts = this.ts;
    const sf = this.sf;
    const text = this.text;
    for (const [pos, messages] of this.todos) {
      const ws = indentAt(text, pos);
      this.changed = true;
      this.edits.insert(
        pos,
        messages.map((m) => `// ${TODO_TAG}: ${m}\n${ws}`).join('')
      );
    }
    if (this.helpers.length) {
      const tail = text.endsWith('\n') ? '' : '\n';
      this.edits.insert(
        text.length,
        () => `${tail}\n${this.helpers.map((h) => h()).join('\n\n')}\n`
      );
    }

    // Drop import specifiers whose every use the codemod rewrote. Imports
    // that were already unused are not the codemod's business.
    const removedImports = new Set<TS.ImportDeclaration>();
    if (this.changed) {
      for (const statement of sf.statements) {
        if (!ts.isImportDeclaration(statement) || !statement.importClause)
          continue;
        const clause = statement.importClause;
        const removable: TS.Node[] = [];
        const named =
          clause.namedBindings && ts.isNamedImports(clause.namedBindings)
            ? clause.namedBindings
            : undefined;
        const unused = (name: TS.Identifier) => {
          const symbol = this.checker.getSymbolAtLocation(name);
          if (!symbol) return false;
          const { total, live } = this.references(symbol, name);
          return total > 0 && live === 0;
        };
        const namespace =
          clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)
            ? clause.namedBindings
            : undefined;
        if (named) {
          for (const element of named.elements) {
            if (unused(element.name)) removable.push(element);
          }
        }
        const defaultGone = !!clause.name && unused(clause.name);
        const namespaceGone = !!namespace && unused(namespace.name);
        if (!removable.length && !defaultGone && !namespaceGone) continue;
        const remaining = named
          ? named.elements.filter((e) => !removable.includes(e))
          : [];
        const keepsDefault = !!clause.name && !defaultGone;
        const keepsNamespace = !!namespace && !namespaceGone;
        this.changed = true;
        if (!remaining.length && !keepsDefault && !keepsNamespace) {
          removedImports.add(statement);
          this.removeStatement(statement);
        } else if (named && removable.length) {
          this.edits.add(
            named.getStart(sf),
            named.end,
            `{ ${remaining.map((e) => e.getText(sf)).join(', ')} }`
          );
        }
      }
    }

    if (this.imports.size) {
      this.changed = true;
      const lines: string[] = [];
      const existing = (module: string) =>
        sf.statements.find(
          (s): s is TS.ImportDeclaration =>
            ts.isImportDeclaration(s) &&
            !removedImports.has(s) &&
            ts.isStringLiteral(s.moduleSpecifier) &&
            s.moduleSpecifier.text === module &&
            !!s.importClause?.namedBindings &&
            ts.isNamedImports(s.importClause.namedBindings) &&
            !s.importClause.isTypeOnly
        );
      for (const [module, wanted] of this.imports) {
        if (!wanted.size) continue;
        const namespace = [...wanted].find((w) => w.startsWith('* as '));
        const rest = [...wanted].filter((w) => !w.startsWith('* as '));
        const current = rest.length ? existing(module) : undefined;
        if (current) {
          const named = current.importClause?.namedBindings as TS.NamedImports;
          const have = new Set(named.elements.map((e) => e.getText(sf)));
          const merged = [...have, ...rest.filter((w) => !have.has(w))].sort(
            sortImports
          );
          this.edits.add(
            named.getStart(sf),
            named.end,
            `{ ${merged.join(', ')} }`
          );
          rest.length = 0;
        }
        if (namespace) {
          lines.push(
            `import ${namespace} from ${this.quote}${module}${this.quote}${this.semi}`
          );
        }
        if (rest.length) {
          lines.push(
            `import { ${rest.sort(sortImports).join(', ')} } from ${this.quote}${module}${this.quote}${this.semi}`
          );
        }
      }
      if (lines.length) {
        const imports = sf.statements.filter(ts.isImportDeclaration);
        const keptImports = imports.filter((i) => !removedImports.has(i));
        const anchor = keptImports[keptImports.length - 1];
        if (anchor) {
          this.edits.insert(anchor.end, `\n${lines.join('\n')}`);
        } else if (imports.length) {
          this.edits.insert(imports[0].getStart(sf), `${lines.join('\n')}\n`);
        } else {
          const first = sf.statements[0];
          this.edits.insert(
            first ? first.getStart(sf) : 0,
            `${lines.join('\n')}\n\n`
          );
        }
      }
    }
    return this.changed ? this.edits.apply() : text;
  }
}

function sortImports(a: string, b: string): number {
  const key = (s: string) => s.replace(/^type /, '').toLowerCase();
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
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

export function skipParens(ts: typeof TS, node: TS.Expression): TS.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression?.(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
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
  node: TS.Expression | undefined
): string | undefined {
  if (!node) return undefined;
  const expr = skipParens(ts, node);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
    return expr.text;
  return undefined;
}

/** Identifiers that introduce a binding. */
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
