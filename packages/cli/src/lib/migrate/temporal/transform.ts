import type * as TS from 'typescript';
import { detectIndentUnit, indentAt } from '../edits.js';
import {
  FileKit,
  getProperty,
  isNonReferenceName,
  literalText,
  propertyNameText,
  skipParens,
} from '../kit.js';
import { isTypeScriptFile, TYPE_END, TYPE_START } from '../markers.js';
import type {
  FileReport,
  LiftedStep,
  MigratedFunction,
  MigratedHook,
  MigrationNote,
} from '../report-types.js';

/**
 * Temporal (TypeScript SDK) -> Workflow SDK codemod for one file.
 *
 * Temporal splits a workflow into a deterministic workflow function and
 * activities it calls through `proxyActivities()`. The Workflow SDK has the
 * same split, without the proxy: an activity becomes a `"use step"` function
 * and the workflow calls it directly. So the codemod
 *
 * - adds `"use workflow"` to every exported workflow function,
 * - replaces each `proxyActivities<typeof activities>()` declaration with a
 *   plain import of the activities, and adds `"use step"` (and the retry
 *   policy as `maxRetries`) to those activities in their own module,
 * - turns signals into hooks: `setHandler()` runs the original handler for
 *   each payload a hook receives, and `condition()` re-checks after each one,
 * - maps `sleep`, `executeChild`/`startChild`, `workflowInfo`, `uuid4`,
 *   `patched`, `log` and `ApplicationFailure`.
 *
 * What has no faithful mechanical mapping (queries, updates, cancellation
 * scopes, `continueAsNew`, ...) is left in place under a
 * `TODO(workflow-migrate)` comment and reported.
 */

export const TEMPORAL_WORKFLOW = '@temporalio/workflow';
const TEMPORAL_MODULES = new Set([
  '@temporalio/workflow',
  '@temporalio/common',
  '@temporalio/activity',
]);

/** How one activity is called, collected across the workflow files. */
export interface ActivityUse {
  /** Retries from `retry.maximumAttempts`; undefined when unlimited. */
  maxRetries?: number;
  /** Two proxies set different retry policies for this activity. */
  conflict?: boolean;
  /** A proxy set options with no Workflow SDK equivalent. */
  notes: string[];
  /** Where it was proxied (for messages). */
  from: string;
}

export interface TemporalContext {
  /** Activities module (absolute file) -> export name -> how it is called. */
  activities: Map<string, Map<string, ActivityUse>>;
}

export interface TemporalTransformOptions {
  ts: typeof TS;
  sourceFile: TS.SourceFile;
  checker: TS.TypeChecker;
  reportName: string;
  context: TemporalContext;
}

type FunctionLike =
  | TS.ArrowFunction
  | TS.FunctionExpression
  | TS.FunctionDeclaration;

const SIGNAL_HELPER = 'TemporalSignals';

export function transformTemporalFile(options: TemporalTransformOptions): {
  code: string;
  report: FileReport;
} {
  const { ts, sourceFile: sf, checker, context } = options;
  const typed = isTypeScriptFile(sf.fileName);
  const kit = new FileKit(ts, sf, checker, typed, detectIndentUnit(sf.text));
  const text = sf.text;
  const { quote, semi } = kit;
  const report: FileReport = {
    file: options.reportName,
    changed: false,
    functions: [],
    notes: [],
    boundary: [],
  };
  const fileNotes = report.notes;
  let signalHelperName: string | undefined;

  // --- Temporal imports ---------------------------------------------------

  /** Local binding symbol -> imported name, per Temporal module. */
  const apiSymbols = new Map<TS.Symbol, { name: string; module: string }>();
  const namespaceSymbols = new Map<TS.Symbol, string>();
  let importsWorkflowApi = false;
  let importsClient = false;
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const module = statement.moduleSpecifier.text;
    if (module === '@temporalio/client' || module === '@temporalio/worker') {
      importsClient = true;
    }
    if (!TEMPORAL_MODULES.has(module)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (module === TEMPORAL_WORKFLOW && !clause.isTypeOnly)
      importsWorkflowApi = true;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const symbol = checker.getSymbolAtLocation(element.name);
        if (symbol) {
          apiSymbols.set(symbol, {
            name: (element.propertyName ?? element.name).text,
            module,
          });
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      const symbol = checker.getSymbolAtLocation(bindings.name);
      if (symbol) namespaceSymbols.set(symbol, module);
    }
  }

  // A Temporal `sleep` import used only as `sleep(...)` is replaced call by
  // call, so the Workflow SDK `sleep` can take over its name.
  for (const [symbol, api] of apiSymbols) {
    if (api.module !== TEMPORAL_WORKFLOW || api.name !== 'sleep') continue;
    const local = symbol.getName();
    let onlyCalled = true;
    const visit = (node: TS.Node): void => {
      if (
        ts.isIdentifier(node) &&
        !ts.isImportSpecifier(node.parent) &&
        checker.getSymbolAtLocation(node) === symbol &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      ) {
        onlyCalled = false;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (onlyCalled) kit.release(local);
  }

  /** The Temporal API an expression names (`sleep`, `wf.sleep`), if any. */
  const apiOf = (
    expr: TS.Node
  ): { name: string; module: string } | undefined => {
    if (ts.isIdentifier(expr)) {
      const symbol = checker.getSymbolAtLocation(expr);
      return symbol ? apiSymbols.get(symbol) : undefined;
    }
    if (
      ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.expression)
    ) {
      const symbol = checker.getSymbolAtLocation(expr.expression);
      const module = symbol && namespaceSymbols.get(symbol);
      return module ? { name: expr.name.text, module } : undefined;
    }
    return undefined;
  };

  /** Call of a Temporal API, e.g. `isApiCall(node, 'sleep')`. */
  const apiCall = (node: TS.Node): string | undefined =>
    ts.isCallExpression(node) ? apiOf(node.expression)?.name : undefined;

  // --- Activities module --------------------------------------------------

  const activityUses = context.activities.get(sf.fileName);
  if (activityUses) migrateActivities(activityUses);

  // --- Workflow file ------------------------------------------------------

  if (importsWorkflowApi) migrateWorkflowFile();
  else if (!activityUses) migrateFailures(sf, fileNotes);

  if (importsClient) scanBoundary();

  report.changed = kit.changed || report.functions.length > 0;
  const code = kit.finish();
  report.changed = report.changed || kit.changed;
  return { code: report.changed ? code : text, report };

  // -----------------------------------------------------------------------

  function migrateWorkflowFile(): void {
    rewriteProxies();
    rewriteDefinitions();
    // Every exported function of a Temporal workflows module is a workflow.
    for (const statement of sf.statements) {
      const fn = exportedFunction(statement);
      if (fn) migrateWorkflow(fn.node, fn.name, statement);
    }
    rewriteCommonApis(sf, fileNotes, undefined);
    migrateFailures(sf, fileNotes);
    flagLeftovers();
  }

  function exportedFunction(
    statement: TS.Statement
  ): { node: FunctionLike; name: string } | undefined {
    const modifiers = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)
      : undefined;
    const exported = !!modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword
    );
    if (!exported) return undefined;
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.body &&
      statement.name
    ) {
      return { node: statement, name: statement.name.text };
    }
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.length === 1
    ) {
      const decl = statement.declarationList.declarations[0];
      const init = decl.initializer && skipParens(ts, decl.initializer);
      if (
        init &&
        ts.isIdentifier(decl.name) &&
        (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
      ) {
        return { node: init, name: decl.name.text };
      }
    }
    return undefined;
  }

  /** Where `async ` goes: before `function`, or before an arrow's parameters. */
  function asyncPosition(fn: FunctionLike): number {
    const keyword = fn
      .getChildren(sf)
      .find((c) => c.kind === ts.SyntaxKind.FunctionKeyword);
    return keyword ? keyword.getStart(sf) : fn.getStart(sf);
  }

  /** Make a function async, wrapping its return type in Promise<>. */
  function makeAsync(fn: FunctionLike): void {
    kit.edits.insert(asyncPosition(fn), 'async ');
    if (fn.type && !/^Promise\s*</.test(fn.type.getText(sf))) {
      const type = fn.type;
      kit.edits.add(
        type.getStart(sf),
        type.end,
        () => `Promise<${type.getText(sf)}>`
      );
    }
    kit.changed = true;
  }

  function isAsync(fn: FunctionLike): boolean {
    return !!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  }

  /** Insert a directive (and optional statements) at the top of a body. */
  function insertAtTop(fn: FunctionLike, lines: () => string[]): void {
    const body = fn.body;
    if (!body) return;
    if (ts.isBlock(body)) {
      // Right after `{`, outside every statement, so it survives a rewrite
      // or removal of the first statement.
      const first = body.statements[0];
      const sameLine =
        first &&
        !text.slice(body.getStart(sf) + 1, first.getStart(sf)).includes('\n');
      const indent =
        first && !sameLine
          ? indentAt(text, first.getStart(sf))
          : indentAt(text, body.getStart(sf)) + kit.indentUnit;
      kit.edits.insert(
        body.getStart(sf) + 1,
        () =>
          lines()
            .map((l) => `\n${indent}${l}`)
            .join('') + (sameLine ? `\n${indent}` : '')
      );
      kit.changed = true;
      return;
    }
    // `async () => expr` -> a block that returns it. The edit renders the
    // body it replaces, so it skips itself while doing so.
    const indent = indentAt(text, fn.getStart(sf)) + kit.indentUnit;
    const start = body.getStart(sf);
    kit.dropped.push([start, body.end]);
    kit.kept.push([start, body.end]);
    kit.changed = true;
    const edit = kit.edits.add(start, body.end, () => {
      const inner = kit.edits.render(start, body.end, edit);
      return `{\n${lines()
        .map((l) => `${indent}${l}\n`)
        .join(
          ''
        )}${indent}return ${inner}${semi}\n${indentAt(text, fn.getStart(sf))}}`;
    });
  }

  // --- proxyActivities ----------------------------------------------------

  /**
   * `const { a, b } = proxyActivities<typeof activities>(opts)` ->
   * `import { a, b } from './activities'`. The activities become steps in
   * their own module (see migrateActivities).
   */
  function rewriteProxies(): void {
    const visit = (node: TS.Node): void => {
      if (
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.length === 1
      ) {
        const decl = node.declarationList.declarations[0];
        const init = decl.initializer && skipParens(ts, decl.initializer);
        const api = init && apiCall(init);
        if (
          init &&
          ts.isCallExpression(init) &&
          (api === 'proxyActivities' || api === 'proxyLocalActivities')
        ) {
          rewriteProxy(node, decl, init);
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  function rewriteProxy(
    statement: TS.VariableStatement,
    decl: TS.VariableDeclaration,
    call: TS.CallExpression
  ): void {
    const typeArg = call.typeArguments?.[0];
    const specifier = typeArg && activitiesSpecifier(typeArg);
    if (!specifier) {
      kit.todo(
        call,
        'This proxy does not name its activities module (`proxyActivities<typeof activities>()`), so the codemod cannot import the activities directly. Import them from their module and add "use step" to each.',
        fileNotes
      );
      return;
    }
    const opts = call.arguments[0];
    if (opts && ts.isObjectLiteralExpression(opts)) {
      const timeouts = opts.properties
        .map((p) => p.name && propertyNameText(ts, p.name))
        .filter((k): k is string => !!k && /Timeout$/.test(k));
      if (timeouts.length) {
        fileNotes.push({
          severity: 'info',
          line: kit.line(call),
          message: `Activity timeouts (${timeouts.map((t) => `\`${t}\``).join(', ')}) have no equivalent: a step runs until it returns, within the function's maximum duration. Race long steps against sleep() in the workflow and pass an AbortSignal into the step if you need a deadline.`,
        });
      }
    }
    if (ts.isObjectBindingPattern(decl.name)) {
      const specifiers: string[] = [];
      for (const element of decl.name.elements) {
        if (
          element.dotDotDotToken ||
          element.initializer ||
          !ts.isIdentifier(element.name)
        ) {
          kit.todo(
            call,
            'This proxy is destructured with a rest element or a default, which the codemod does not rewrite. Import the activities from their module instead.',
            fileNotes
          );
          return;
        }
        const exported = element.propertyName
          ? propertyNameText(ts, element.propertyName)
          : element.name.text;
        if (!exported) return;
        specifiers.push(
          exported === element.name.text
            ? exported
            : `${exported} as ${element.name.text}`
        );
      }
      if (enclosingFunction(statement)) {
        // The names become module-level imports: they must not collide.
        for (const element of decl.name.elements) {
          const name = (element.name as TS.Identifier).text;
          if (moduleLevelBinding(name)) {
            kit.todo(
              call,
              `\`${name}\` is also declared at module scope, so this proxy cannot become an import. Import the activity under another name.`,
              fileNotes
            );
            return;
          }
        }
      }
      kit.removeStatement(statement);
      kit.addModuleImport(specifier, specifiers);
      return;
    }
    if (ts.isIdentifier(decl.name)) {
      kit.removeStatement(statement);
      kit.addModuleImport(specifier, [`* as ${decl.name.text}`]);
      return;
    }
    kit.todo(
      call,
      'This proxy is not assigned to a const the codemod understands.',
      fileNotes
    );
  }

  function moduleLevelBinding(name: string): boolean {
    for (const statement of sf.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const d of statement.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) return true;
        }
      }
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
        statement.name?.text === name
      ) {
        return true;
      }
    }
    return false;
  }

  /** `typeof activities` (namespace import) or `typeof import('./acts')`. */
  function activitiesSpecifier(typeArg: TS.TypeNode): string | undefined {
    if (ts.isImportTypeNode(typeArg) && typeArg.isTypeOf) {
      const arg = typeArg.argument;
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal))
        return arg.literal.text;
      return undefined;
    }
    if (ts.isTypeQueryNode(typeArg) && ts.isIdentifier(typeArg.exprName)) {
      const symbol = checker.getSymbolAtLocation(typeArg.exprName);
      const declaration = symbol?.declarations?.[0];
      if (declaration && ts.isNamespaceImport(declaration)) {
        const importDecl = declaration.parent.parent;
        if (ts.isStringLiteral(importDecl.moduleSpecifier))
          return importDecl.moduleSpecifier.text;
      }
    }
    return undefined;
  }

  // --- Signal, query and update definitions -------------------------------

  /**
   * `defineSignal<[boolean]>('approve')` -> `{ type: 'signal', name: 'approve' }`,
   * the same shape as Temporal's SignalDefinition, so `.name` keeps working
   * for the workflow (hook tokens) and the code that sends the signal.
   */
  function rewriteDefinitions(): void {
    const visit = (node: TS.Node): void => {
      if (ts.isCallExpression(node) && apiCall(node) === 'defineSignal') {
        const name = node.arguments[0];
        if (name && literalText(ts, name) !== undefined) {
          kit.replace(
            node,
            () =>
              `{ type: ${quote}signal${quote}, name: ${kit.render(name)} }${typed ? ' as const' : ''}`,
            [name]
          );
          return;
        }
        kit.todo(
          node,
          "A signal defined with a computed name: define it as `{ type: 'signal', name }` with a literal name.",
          fileNotes
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  /** What `setHandler(def, ...)` registers for: the definition's kind, name and args type. */
  function definitionOf(
    expr: TS.Expression
  ): { kind: 'signal' | 'query' | 'update'; argsType?: string } | undefined {
    let symbol = checker.getSymbolAtLocation(expr);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        // keep the alias
      }
    }
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer
    ) {
      return undefined;
    }
    const init = skipParens(ts, declaration.initializer);
    if (!ts.isCallExpression(init)) {
      // Already rewritten to `{ type: 'signal', name }` (or written that way).
      if (ts.isObjectLiteralExpression(init)) {
        const type = literalText(ts, getProperty(ts, init, 'type'));
        if (type === 'signal' || type === 'query' || type === 'update')
          return { kind: type };
      }
      return undefined;
    }
    const callee = init.expression;
    const calleeName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : '';
    const kind =
      calleeName === 'defineSignal'
        ? 'signal'
        : calleeName === 'defineQuery'
          ? 'query'
          : calleeName === 'defineUpdate'
            ? 'update'
            : undefined;
    if (!kind) return undefined;
    // defineSignal<Args>, defineQuery<Ret, Args>, defineUpdate<Ret, Args>
    const argsNode =
      kind === 'signal' ? init.typeArguments?.[0] : init.typeArguments?.[1];
    return { kind, argsType: argsNode?.getText(declaration.getSourceFile()) };
  }

  // --- Workflow functions -------------------------------------------------

  function migrateWorkflow(
    fn: FunctionLike,
    name: string,
    statement: TS.Statement
  ): void {
    const notes: MigrationNote[] = [];
    const migrated: MigratedFunction = {
      sourceId: name,
      workflowName: name,
      line: kit.line(statement),
      triggers: [],
      steps: [],
      hooks: [],
      notes,
      config: {},
    };
    report.functions.push(migrated);
    if (!isAsync(fn)) {
      notes.push({
        severity: 'info',
        line: kit.line(fn),
        message: `\`${name}\` is not async; workflow functions must return a promise, so it was made async.`,
      });
      makeAsync(fn);
    }

    // Signals handled in this workflow.
    const signalHandlers: Array<{
      call: TS.CallExpression;
      def: TS.Expression;
      argsType?: string;
    }> = [];
    const conditions: TS.CallExpression[] = [];
    const visit = (node: TS.Node): void => {
      const api = apiCall(node);
      if (api === 'setHandler' && ts.isCallExpression(node)) {
        const [def, handler] = node.arguments;
        const definition = def && definitionOf(def);
        if (!def || !handler || !definition) {
          kit.todo(
            node,
            '`setHandler()` for a definition the codemod could not resolve. Signals become hooks: see the other signals in this file, or `createHook()` in the Workflow SDK docs.',
            notes
          );
        } else if (definition.kind === 'signal') {
          if (
            handler.kind === ts.SyntaxKind.UndefinedKeyword ||
            (ts.isIdentifier(handler) && handler.text === 'undefined')
          ) {
            kit.todo(
              node,
              'Removing a signal handler has no hook equivalent: stop reading the hook instead (`hook.dispose()`).',
              notes
            );
          } else {
            signalHandlers.push({
              call: node,
              def,
              argsType: definition.argsType,
            });
          }
        } else if (definition.kind === 'query') {
          kit.todo(
            node,
            'Queries read workflow state while the run is going. Publish that state as it changes instead: write it to a stream (`getWritable()`, from a step) that clients read, or to run attributes (`setAttributes()`).',
            notes
          );
        } else {
          kit.todo(
            node,
            'Updates send a value in and return a result. Receive the value through a hook (`createHook()` + `resumeHook()`), and return the result through a stream or a second hook the caller waits on.',
            notes
          );
        }
      } else if (api === 'condition' && ts.isCallExpression(node)) {
        conditions.push(node);
      }
      ts.forEachChild(node, visit);
    };
    if (fn.body) visit(fn.body);

    const localName = (base: string) => {
      let name = base;
      for (let n = 2; kit.identifiers.has(name); n++) name = `${base}${n}`;
      return name;
    };
    const signalsVar =
      signalHandlers.length || conditions.length
        ? localName('signals')
        : undefined;
    const hookVars = new Map<string, string>();
    const topLines: Array<() => string> = [];

    if (signalsVar) {
      const helper = signalHelper();
      topLines.push(() => `const ${signalsVar} = new ${helper}()${semi}`);
    }
    for (const { call, def, argsType } of signalHandlers) {
      const defText = def.getText(sf);
      if (hookVars.has(defText)) {
        kit.todo(
          call,
          'A second handler for the same signal replaces the first in Temporal. Merge the handlers into one.',
          notes
        );
        continue;
      }
      const hookVar = localName(
        `${ts.isIdentifier(def) ? def.text : 'signal'}Hook`
      );
      hookVars.set(defText, hookVar);
      const typeArg =
        typed && argsType ? `<${TYPE_START}${argsType}${TYPE_END}>` : '';
      // The hook is created when the run starts, so a signal sent before
      // the handler is registered waits in it, as Temporal buffers it.
      topLines.push(
        () =>
          `const ${hookVar} = ${signalsVar}.hook${typeArg}(${defText}.name)${semi}`
      );
      const handler = call.arguments[1];
      kit.replace(
        call,
        () => `${signalsVar}.handle(${hookVar}, ${kit.render(handler)})`,
        [handler]
      );
      const signalName = signalNameOf(def);
      const hook: MigratedHook = {
        line: kit.line(call),
        source: 'step.waitForSignal',
        name: signalName ?? defText,
        token: `\`\${runId}:${signalName ?? `\${${defText}.name}`}\``,
        resumeToken: `\`\${run.runId}:${signalName ?? `\${${defText}.name}`}\``,
      };
      migrated.hooks.push(hook);
    }
    for (const call of conditions) {
      const [predicate, timeout] = call.arguments;
      if (!predicate || !signalHandlers.length) {
        kit.todo(
          call,
          '`condition()` waits for state no signal handler in this workflow changes. Wait on what changes it instead: a hook, a step result, or `sleep()`.',
          notes
        );
        continue;
      }
      const sleep = timeout ? kit.use('workflow', 'sleep') : '';
      kit.replace(
        call,
        () =>
          `${signalsVar}.condition(${kit.render(predicate)}${timeout ? `, () => ${sleep}(${kit.render(timeout)})` : ''})`,
        timeout ? [predicate, timeout] : [predicate]
      );
    }

    insertAtTop(fn, () => [
      `${quote}use workflow${quote}${semi}`,
      ...topLines.map((l) => l()),
    ]);
    rewriteCommonApis(fn, notes, migrated);
    for (const n of notes) n.line = n.line || migrated.line;
    notes.sort((a, b) => a.line - b.line);
  }

  function signalNameOf(def: TS.Expression): string | undefined {
    let symbol = checker.getSymbolAtLocation(def);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        // keep
      }
    }
    const declaration = symbol?.valueDeclaration;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer
    )
      return undefined;
    const init = skipParens(ts, declaration.initializer);
    if (ts.isCallExpression(init)) return literalText(ts, init.arguments[0]);
    if (ts.isObjectLiteralExpression(init))
      return literalText(ts, getProperty(ts, init, 'name'));
    return undefined;
  }

  function signalHelper(): string {
    if (signalHelperName) return signalHelperName;
    const name = kit.names.allocate(SIGNAL_HELPER, '');
    signalHelperName = name;
    const createHook = kit.use('workflow', 'createHook');
    const metadata = kit.use('workflow', 'getWorkflowMetadata');
    const hookType = typed ? kit.useType('Hook') : '';
    kit.helper(() => {
      const I = kit.indentUnit;
      const t = (s: string) => (typed ? s : '');
      const s = semi;
      return [
        `/**`,
        ` * Temporal signals on Workflow SDK hooks. Each signal has a hook with the`,
        ` * token \`\${runId}:<signal name>\`, created when the run starts so a signal`,
        ` * sent early waits in it. handle() runs the handler for each payload in`,
        ` * order (the payload is the signal's arguments array), and condition()`,
        ` * re-checks its predicate after each one.`,
        ` */`,
        `class ${name} {`,
        `${I}${t('private readonly ')}runId = ${metadata}().workflowRunId${s}`,
        `${I}${t('private ')}waiters${t(': Array<() => void>')} = []${s}`,
        ``,
        `${I}hook${t('<Args extends unknown[] = any[]>')}(name${t(': string')})${t(`: ${hookType}<Args>`)} {`,
        `${I}${I}return ${createHook}${t('<Args>')}({ token: \`\${this.runId}:\${name}\` })${s}`,
        `${I}}`,
        ``,
        `${I}handle${t('<Args extends unknown[]>')}(hook${t(`: ${hookType}<Args>`)}, handler${t(': (...args: Args) => unknown')})${t(': void')} {`,
        `${I}${I}void (async () => {`,
        `${I}${I}${I}for await (const args of hook) {`,
        `${I}${I}${I}${I}await handler(...args)${s}`,
        `${I}${I}${I}${I}const waiters = this.waiters${s}`,
        `${I}${I}${I}${I}this.waiters = []${s}`,
        `${I}${I}${I}${I}for (const wake of waiters) wake()${s}`,
        `${I}${I}${I}}`,
        `${I}${I}})()${s}`,
        `${I}}`,
        ``,
        `${I}async condition(fn${t(': () => boolean')}, timeout${t('?: () => Promise<void>')})${t(': Promise<boolean>')} {`,
        `${I}${I}let expired${t(': Promise<false> | undefined')}${s}`,
        `${I}${I}while (!fn()) {`,
        `${I}${I}${I}expired ??= timeout?.().then(() => false${t(' as const')})${s}`,
        `${I}${I}${I}const changed = new Promise${t('<true>')}((wake) => this.waiters.push(() => wake(true)))${s}`,
        `${I}${I}${I}if ((await (expired ? Promise.race([changed, expired]) : changed)) === false) return false${s}`,
        `${I}${I}}`,
        `${I}${I}return true${s}`,
        `${I}}`,
        `}`,
      ].join('\n');
    });
    return name;
  }

  // --- APIs shared by workflow code ---------------------------------------

  /**
   * sleep, log, uuid4, patched, deprecatePatch, workflowInfo, executeChild,
   * startChild, continueAsNew and the APIs with no equivalent, inside `scope`.
   */
  function rewriteCommonApis(
    scope: TS.Node,
    notes: MigrationNote[],
    fn: MigratedFunction | undefined
  ): void {
    const visit = (node: TS.Node): void => {
      // Skip workflow bodies when rewriting the module scope: they are
      // rewritten with their own notes.
      if (!fn && node !== scope && isWorkflowFunctionNode(node)) return;
      if (ts.isCallExpression(node)) {
        const api = apiOf(node.expression);
        if (
          api?.module === TEMPORAL_WORKFLOW &&
          handleCall(node, api.name, notes)
        )
          return;
      }
      if (
        (ts.isIdentifier(node) &&
          !isNonReferenceName(ts, node) &&
          !ts.isImportSpecifier(node.parent)) ||
        (ts.isPropertyAccessExpression(node) &&
          ts.isIdentifier(node.expression))
      ) {
        const api = apiOf(node);
        if (
          api?.module === TEMPORAL_WORKFLOW &&
          !(ts.isCallExpression(node.parent) && node.parent.expression === node)
        ) {
          if (handleReference(node, api.name, notes)) return;
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(scope, visit);
  }

  function isWorkflowFunctionNode(node: TS.Node): boolean {
    for (const statement of sf.statements) {
      const fn = exportedFunction(statement);
      if (fn && fn.node === node) return true;
    }
    return false;
  }

  /** Returns true when the call was handled (rewritten or flagged). */
  function handleCall(
    call: TS.CallExpression,
    api: string,
    notes: MigrationNote[]
  ): boolean {
    switch (api) {
      case 'sleep': {
        const sleep = kit.use('workflow', 'sleep');
        kit.replace(call.expression, sleep);
        if (call.arguments.length > 1) {
          notes.push({
            severity: 'info',
            line: kit.line(call),
            message: 'sleep() options (a timer summary) were dropped.',
          });
        }
        return false; // keep visiting the arguments
      }
      case 'uuid4':
        kit.replace(call, 'crypto.randomUUID()');
        return true;
      case 'patched':
        // Runs are pinned to the deployment that started them, so every run
        // of this code is a "new" run.
        if (
          ts.isConditionalExpression(call.parent) &&
          call.parent.condition === call
        ) {
          const branch = call.parent.whenTrue;
          kit.replace(call.parent, () => kit.render(branch), [branch]);
        } else {
          kit.replace(call, 'true');
        }
        notes.push({
          severity: 'info',
          line: kit.line(call),
          message:
            'patched() is now `true`: runs keep the code of the deployment that started them, so a run of this code always takes the new branch. Delete the old branch once the old runs have drained.',
        });
        return true;
      case 'deprecatePatch': {
        const statement = kit.statementOf(call);
        if (
          statement &&
          ts.isExpressionStatement(statement) &&
          statement.expression === call
        ) {
          kit.removeStatement(statement);
          return true;
        }
        kit.todo(
          call,
          '`deprecatePatch()` has no equivalent and can be deleted.',
          notes
        );
        return true;
      }
      case 'workflowInfo':
        return rewriteWorkflowInfo(call, notes);
      case 'executeChild':
      case 'startChild':
        return rewriteChild(call, api, notes);
      case 'continueAsNew':
      case 'makeContinueAsNewFunc':
        kit.todo(
          call,
          "continueAsNew() is not needed: Temporal restarts a run because it caps a run's event history and payloads. Keep this run going instead: continue the loop with the new state (or delete the call where the loop already continues), and start runs with WORKFLOW_VM=quickjs, where snapshotting exempts a run from the default event limit and keeps each resume fast as the log grows. Start a new run only to move onto newer code: `start(thisWorkflow, [state], { deploymentId: 'latest' })` from workflow/api, then return.",
          notes
        );
        return true;
      case 'setHandler':
      case 'condition':
      case 'proxyActivities':
      case 'proxyLocalActivities':
      case 'defineSignal':
        return false; // handled elsewhere
      default:
        if (UNSUPPORTED[api]) {
          kit.todo(call, UNSUPPORTED[api], notes);
          return true;
        }
        return false;
    }
  }

  function handleReference(
    node: TS.Node,
    api: string,
    notes: MigrationNote[]
  ): boolean {
    if (api === 'log') {
      kit.replace(node, 'console');
      return true;
    }
    if (UNSUPPORTED[api]) {
      kit.todo(node, UNSUPPORTED[api], notes);
      return true;
    }
    return false;
  }

  /** `workflowInfo().runId` -> `getWorkflowMetadata().workflowRunId`. */
  function rewriteWorkflowInfo(
    call: TS.CallExpression,
    notes: MigrationNote[]
  ): boolean {
    const parent = call.parent;
    const metadata = () => kit.use('workflow', 'getWorkflowMetadata');
    const mapped: Record<string, string> = {
      runId: 'workflowRunId',
      workflowType: 'workflowName',
      startTime: 'workflowStartedAt',
      runStartTime: 'workflowStartedAt',
    };
    if (ts.isPropertyAccessExpression(parent) && parent.expression === call) {
      const target = mapped[parent.name.text];
      if (target) {
        const fn = metadata();
        // workflowName is the full workflow ID (`workflow//<module>//<name>`);
        // Temporal's workflowType is the function name at its end.
        const suffix =
          parent.name.text === 'workflowType'
            ? `.replace(/^.*\\//, ${quote}${quote})`
            : '';
        kit.replace(parent, `${fn}().${target}${suffix}`);
        return true;
      }
      if (
        ['historyLength', 'historySize', 'continueAsNewSuggested'].includes(
          parent.name.text
        )
      ) {
        kit.todo(
          call,
          `\`workflowInfo().${parent.name.text}\` only decided when to continue-as-new, which the Workflow SDK does not need (see the continueAsNew() TODO): remove the check and keep the run going.`,
          notes
        );
        return true;
      }
      kit.todo(
        call,
        `\`workflowInfo().${parent.name.text}\` has no equivalent in getWorkflowMetadata() (it has workflowRunId, workflowName and workflowStartedAt). A Temporal workflow ID is the start token the caller chose: pass it in as an argument if the workflow needs it.`,
        notes
      );
      return true;
    }
    kit.todo(
      call,
      'workflowInfo() maps to getWorkflowMetadata() (workflowRunId, workflowName, workflowStartedAt); rewrite the fields this code reads.',
      notes
    );
    return true;
  }

  /**
   * `executeChild(child, { args, workflowId })` ->
   * `start(child, args, { experimental_hook: { token: workflowId } }).then((run) => run.returnValue)`.
   */
  function rewriteChild(
    call: TS.CallExpression,
    api: string,
    notes: MigrationNote[]
  ): boolean {
    const [target, opts] = call.arguments;
    if (!target || !ts.isIdentifier(skipParens(ts, target))) {
      kit.todo(
        call,
        `\`${api}()\` names the child workflow by its type string. Import the child workflow function and call start(child, args) from workflow/api.`,
        notes
      );
      return true;
    }
    let args: TS.Expression | undefined;
    let workflowId: TS.Expression | undefined;
    if (opts) {
      if (!ts.isObjectLiteralExpression(opts)) {
        kit.todo(
          call,
          `\`${api}()\` options are not an object literal.`,
          notes
        );
        return true;
      }
      args = getProperty(ts, opts, 'args');
      workflowId = getProperty(ts, opts, 'workflowId');
      const dropped = opts.properties
        .map((p) => p.name && propertyNameText(ts, p.name))
        .filter((k): k is string => !!k && k !== 'args' && k !== 'workflowId');
      if (dropped.length) {
        notes.push({
          severity: 'info',
          line: kit.line(call),
          message: `\`${api}()\` options ${dropped.map((k) => `\`${k}\``).join(', ')} were dropped: a child run is an ordinary run of its workflow.`,
        });
      }
    }
    const start = kit.use('workflow/api', 'start');
    const kept = [
      target,
      ...(args ? [args] : []),
      ...(workflowId ? [workflowId] : []),
    ];
    kit.replace(
      call,
      () => {
        const argsText = args ? kit.render(args) : '[]';
        const options = workflowId
          ? `, { experimental_hook: { token: ${kit.render(workflowId)} } }`
          : '';
        const started = `${start}(${kit.render(target)}, ${argsText}${options})`;
        return api === 'executeChild'
          ? `${started}.then((run) => run.returnValue)`
          : started;
      },
      kept
    );
    if (api === 'startChild') rewriteChildHandle(call, notes);
    if (workflowId) {
      notes.push({
        severity: 'info',
        line: kit.line(call),
        message:
          'The child `workflowId` is now its start token: a second start with the same token throws HookConflictError while the child runs.',
      });
    }
    return false;
  }

  /** `const child = await startChild(...)`: `child.result()` -> `child.returnValue`. */
  function rewriteChildHandle(
    call: TS.CallExpression,
    notes: MigrationNote[]
  ): void {
    let node: TS.Node = call;
    if (ts.isAwaitExpression(node.parent)) node = node.parent;
    const decl = node.parent;
    if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return;
    const symbol = checker.getSymbolAtLocation(decl.name);
    const scope = kit.statementOf(decl)?.parent ?? sf;
    const visit = (n: TS.Node): void => {
      if (
        ts.isIdentifier(n) &&
        n !== decl.name &&
        checker.getSymbolAtLocation(n) === symbol
      ) {
        const access = n.parent;
        if (ts.isPropertyAccessExpression(access) && access.expression === n) {
          if (
            access.name.text === 'result' &&
            ts.isCallExpression(access.parent) &&
            access.parent.expression === access
          ) {
            kit.replace(access.parent, `${n.text}.returnValue`);
            return;
          }
          if (access.name.text === 'workflowId') {
            kit.todo(
              access,
              'A child handle has no workflowId; use `run.runId`, or the start token you passed.',
              notes
            );
            return;
          }
          if (access.name.text === 'signal') {
            kit.todo(
              access,
              'Signalling a child: create a hook in the child and call resumeHook() from a step in the parent.',
              notes
            );
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
  }

  /** References to Temporal APIs nothing above rewrote. */
  function flagLeftovers(): void {
    const visit = (node: TS.Node): void => {
      if (
        ts.isIdentifier(node) &&
        !isNonReferenceName(ts, node) &&
        !ts.isImportSpecifier(node.parent)
      ) {
        const api = apiOf(node);
        if (
          api &&
          api.module === TEMPORAL_WORKFLOW &&
          !kit.isDropped(node.getStart(sf), node.end) &&
          !HANDLED.has(api.name) &&
          !(api.name in UNSUPPORTED)
        ) {
          kit.todo(
            node,
            `\`${api.name}\` from @temporalio/workflow has no Workflow SDK equivalent the codemod knows about.`,
            fileNotes
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement)) visit(statement);
    }
  }

  // --- Failures (workflows and activities) --------------------------------

  /**
   * `ApplicationFailure.nonRetryable(msg)` -> `new FatalError(msg)`,
   * `ApplicationFailure.retryable(msg)` -> `new Error(msg)`,
   * `ApplicationFailure.create({ message, nonRetryable, nextRetryDelay })`.
   */
  function migrateFailures(scope: TS.Node, notes: MigrationNote[]): void {
    const visit = (node: TS.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        apiOf(node.expression.expression)?.name === 'ApplicationFailure'
      ) {
        const method = node.expression.name.text;
        const [first] = node.arguments;
        if (method === 'nonRetryable' || method === 'retryable') {
          const ctor =
            method === 'nonRetryable'
              ? kit.use('workflow', 'FatalError')
              : 'Error';
          kit.replace(
            node,
            () => `new ${ctor}(${first ? kit.render(first) : "''"})`,
            first ? [first] : []
          );
          if (node.arguments.length > 1) {
            notes.push({
              severity: 'info',
              line: kit.line(node),
              message:
                'The failure `type` and `details` were dropped; put what callers need in the message, or throw your own Error subclass.',
            });
          }
          return;
        }
        if (
          method === 'create' &&
          first &&
          ts.isObjectLiteralExpression(first)
        ) {
          const message = getProperty(ts, first, 'message');
          const nonRetryable = getProperty(ts, first, 'nonRetryable');
          const delay = getProperty(ts, first, 'nextRetryDelay');
          const fatal = nonRetryable?.kind === ts.SyntaxKind.TrueKeyword;
          const msg = () => (message ? kit.render(message) : "''");
          const kept = [message, delay].filter((n): n is TS.Expression => !!n);
          if (
            nonRetryable &&
            !fatal &&
            nonRetryable.kind !== ts.SyntaxKind.FalseKeyword
          ) {
            kit.todo(
              node,
              '`nonRetryable` is not a literal: throw FatalError when it is true.',
              notes
            );
            return;
          }
          if (fatal) {
            const ctor = kit.use('workflow', 'FatalError');
            kit.replace(node, () => `new ${ctor}(${msg()})`, kept);
          } else if (delay) {
            const ctor = kit.use('workflow', 'RetryableError');
            kit.replace(
              node,
              () =>
                `new ${ctor}(${msg()}, { retryAfter: ${kit.render(delay)} })`,
              kept
            );
          } else {
            kit.replace(node, () => `new Error(${msg()})`, kept);
          }
          return;
        }
        kit.todo(
          node,
          `\`ApplicationFailure.${method}()\`: throw FatalError (no retry), RetryableError (retry after a delay) or Error (retry) from workflow.`,
          notes
        );
        return;
      }
      if (
        ts.isNewExpression(node) &&
        apiOf(node.expression)?.name === 'ApplicationFailure'
      ) {
        kit.todo(
          node,
          '`new ApplicationFailure()`: throw FatalError (no retry), RetryableError (retry after a delay) or Error (retry) from workflow.',
          notes
        );
        return;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
      ) {
        const api = apiOf(node.right);
        if (api && FAILURE_CLASSES.has(api.name)) {
          kit.todo(
            node,
            `\`instanceof ${api.name}\`: a step's error reaches the workflow as the error the step threw (FatalError.is(), RetryableError.is()), and a child's as WorkflowRunFailedError with the child's error as its cause.`,
            notes
          );
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
  }

  // --- Activities ---------------------------------------------------------

  function migrateActivities(uses: Map<string, ActivityUse>): void {
    const steps: LiftedStep[] = [];
    for (const [name, use] of uses) {
      const found = activityDeclaration(name);
      if (!found) {
        fileNotes.push({
          severity: 'todo',
          line: 1,
          message: `The activity \`${name}\` (proxied in ${use.from}) is not declared in this file as an exported function, so it was not made a step. Add "use step" to it where it is declared.`,
        });
        continue;
      }
      const { fn, statement } = found;
      if (!fn.body) continue;
      if (!isAsync(fn)) {
        makeAsync(fn);
        fileNotes.push({
          severity: 'info',
          line: kit.line(fn),
          message: `\`${name}\` was made async: step functions return a promise. Callers outside workflows now get a promise too.`,
        });
      }
      insertAtTop(fn, () => [`${quote}use step${quote}${semi}`]);
      const end = statement.end;
      if (use.conflict) {
        kit.todo(
          statement,
          `\`${name}\` is proxied with different retry policies; a step has one \`maxRetries\`. Set \`${name}.maxRetries\` to the one you want.`,
          fileNotes
        );
      } else if (use.maxRetries !== undefined) {
        kit.edits.insert(
          end,
          `\n${name}.maxRetries = ${use.maxRetries}${semi}`
        );
      } else {
        kit.todo(
          statement,
          `Temporal retried \`${name}\` without limit (its retry policy sets no \`maximumAttempts\`). A step retries 3 times by default: set \`${name}.maxRetries\` to what you need.`,
          fileNotes
        );
      }
      for (const note of use.notes)
        fileNotes.push({
          severity: 'info',
          line: kit.line(statement),
          message: note,
        });
      steps.push({
        stepId: name,
        dynamicId: false,
        functionName: name,
        line: kit.line(statement),
        source: 'step.run',
        captured: [],
        inputs: fn.parameters.length,
      });
    }
    report.steps = steps;
    migrateFailures(sf, fileNotes);
    migrateActivityContext();
  }

  function activityDeclaration(
    name: string
  ): { fn: FunctionLike; statement: TS.Statement } | undefined {
    for (const statement of sf.statements) {
      const exported = exportedFunction(statement);
      if (exported?.name === name) return { fn: exported.node, statement };
    }
    return undefined;
  }

  /** `Context.current().info.attempt`, `activityInfo()`, `heartbeat()`, `log`. */
  function migrateActivityContext(): void {
    const visit = (node: TS.Node): void => {
      // activityInfo().attempt / Context.current().info.attempt
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'attempt') {
        const base = node.expression;
        const fromInfo =
          (ts.isCallExpression(base) && apiCall(base) === 'activityInfo') ||
          (ts.isPropertyAccessExpression(base) &&
            base.name.text === 'info' &&
            isContextCurrent(base.expression));
        if (fromInfo) {
          // Both count from 1.
          const metadata = kit.use('workflow', 'getStepMetadata');
          kit.replace(node, `${metadata}().attempt`);
          return;
        }
      }
      // const { attempt } = Context.current().info / activityInfo()
      if (
        (ts.isPropertyAccessExpression(node) &&
          node.name.text === 'info' &&
          isContextCurrent(node.expression)) ||
        (ts.isCallExpression(node) && apiCall(node) === 'activityInfo')
      ) {
        const decl = node.parent;
        if (
          ts.isVariableDeclaration(decl) &&
          decl.initializer === node &&
          ts.isObjectBindingPattern(decl.name) &&
          decl.name.elements.every(
            (e) =>
              !e.dotDotDotToken &&
              propertyNameText(ts, e.propertyName ?? e.name) === 'attempt'
          )
        ) {
          const metadata = kit.use('workflow', 'getStepMetadata');
          kit.replace(node, `${metadata}()`);
          return;
        }
      }
      if (ts.isCallExpression(node)) {
        const api = apiCall(node);
        const contextMethod =
          ts.isPropertyAccessExpression(node.expression) &&
          isContextCurrent(node.expression.expression)
            ? node.expression.name.text
            : undefined;
        if (api === 'heartbeat' || contextMethod === 'heartbeat') {
          const statement = kit.statementOf(node);
          if (
            statement &&
            ts.isExpressionStatement(statement) &&
            statement.expression === node
          ) {
            kit.removeStatement(statement);
            fileNotes.push({
              severity: 'info',
              line: kit.line(node),
              message:
                'heartbeat() was removed: a step has no heartbeat timeout. A retried step starts over, so keep progress you need in its return value or your database.',
            });
            return;
          }
        }
        if (
          api === 'activityInfo' ||
          api === 'cancellationSignal' ||
          api === 'cancelled' ||
          api === 'getClient' ||
          api === 'sleep' ||
          contextMethod
        ) {
          kit.todo(
            node,
            ACTIVITY_GUIDANCE[api ?? contextMethod ?? ''] ??
              `\`${node.expression.getText(sf)}()\` from @temporalio/activity has no equivalent inside a step.`,
            fileNotes
          );
          return;
        }
      }
      if (
        ts.isIdentifier(node) &&
        !isNonReferenceName(ts, node) &&
        !ts.isImportSpecifier(node.parent)
      ) {
        const api = apiOf(node);
        if (api?.module === '@temporalio/activity' && api.name === 'log') {
          kit.replace(node, 'console');
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement)) visit(statement);
    }
    // Anything from @temporalio/activity the rewrites above left.
    const leftovers = (node: TS.Node): void => {
      if (
        ts.isIdentifier(node) &&
        !isNonReferenceName(ts, node) &&
        !ts.isImportSpecifier(node.parent)
      ) {
        const api = apiOf(node);
        if (
          api?.module === '@temporalio/activity' &&
          !FAILURE_CLASSES.has(api.name) &&
          !kit.isDropped(node.getStart(sf), node.end)
        ) {
          kit.todo(
            node,
            ACTIVITY_GUIDANCE[api.name] ?? ACTIVITY_GUIDANCE.info,
            fileNotes
          );
        }
      }
      ts.forEachChild(node, leftovers);
    };
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement)) leftovers(statement);
    }
  }

  function isContextCurrent(node: TS.Expression): boolean {
    return (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'current' &&
      apiOf(node.expression.expression)?.name === 'Context'
    );
  }

  // --- App boundary -------------------------------------------------------

  function scanBoundary(): void {
    const visit = (node: TS.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression;
        const onWorkflowClient =
          ts.isPropertyAccessExpression(receiver) &&
          receiver.name.text === 'workflow';
        const textOf = () => singleLine(node.getText(sf));
        if (
          onWorkflowClient &&
          ['start', 'execute', 'signalWithStart', 'getHandle'].includes(method)
        ) {
          report.boundary.push({
            line: kit.line(node),
            kind: method,
            names: workflowNames(node),
            text: textOf(),
          });
        } else if (
          method === 'signal' &&
          node.arguments[0] &&
          definitionOf(node.arguments[0])?.kind === 'signal'
        ) {
          report.boundary.push({
            line: kit.line(node),
            kind: 'signal',
            names: [
              signalNameOf(node.arguments[0]) ?? node.arguments[0].getText(sf),
            ],
            text: textOf(),
          });
        } else if (['query', 'executeUpdate', 'startUpdate'].includes(method)) {
          report.boundary.push({
            line: kit.line(node),
            kind: method,
            names: [],
            text: textOf(),
          });
        } else if (
          method === 'create' &&
          ts.isPropertyAccessExpression(receiver) &&
          receiver.name.text === 'schedule'
        ) {
          // client.schedule.create({ scheduleId, spec, action })
          report.boundary.push({
            line: kit.line(node),
            kind: 'schedule',
            names: [],
            text: textOf(),
          });
        } else if (
          method === 'create' &&
          ts.isIdentifier(receiver) &&
          receiver.text === 'Worker'
        ) {
          report.boundary.push({
            line: kit.line(node),
            kind: 'worker',
            names: [],
            text: textOf(),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  function workflowNames(call: TS.CallExpression): string[] {
    const target = call.arguments[0];
    if (!target) return [];
    if (ts.isIdentifier(target)) return [target.text];
    const literal = literalText(ts, target);
    return literal ? [literal] : [];
  }

  function enclosingFunction(node: TS.Node): TS.Node | undefined {
    let current = node.parent;
    while (current) {
      if (ts.isFunctionLike(current)) return current;
      current = current.parent;
    }
    return undefined;
  }
}

const HANDLED = new Set([
  'sleep',
  'log',
  'uuid4',
  'patched',
  'deprecatePatch',
  'workflowInfo',
  'executeChild',
  'startChild',
  'continueAsNew',
  'makeContinueAsNewFunc',
  'setHandler',
  'condition',
  'proxyActivities',
  'proxyLocalActivities',
  'defineSignal',
  'defineQuery',
  'defineUpdate',
  'ApplicationFailure',
  'ActivityFailure',
  'ChildWorkflowFailure',
  'CancelledFailure',
  'TimeoutFailure',
  'TerminatedFailure',
]);

const FAILURE_CLASSES = new Set([
  'ApplicationFailure',
  'ActivityFailure',
  'ChildWorkflowFailure',
  'CancelledFailure',
  'TimeoutFailure',
  'TerminatedFailure',
  'TemporalFailure',
]);

const UNSUPPORTED: Record<string, string> = {
  CancellationScope:
    'CancellationScope has no equivalent. To abandon work, create an AbortController in the workflow, pass its signal into the steps, and call abort(); to cancel a whole run, call run.cancel().',
  isCancellation:
    "isCancellation(): a cancelled run ends with WorkflowRunCancelledError for whoever awaits it; inside the run, an aborted step rejects with the AbortSignal's reason.",
  Trigger:
    'Trigger has no equivalent. Resolve a hook (createHook() + resumeHook()) or use a plain promise the workflow controls.',
  getExternalWorkflowHandle:
    'Signalling or cancelling another workflow: call resumeHook() (for a signal) or getRun(runId).cancel() from a "use step" function.',
  upsertSearchAttributes:
    'Search attributes map to run attributes: setAttributes({ key: "value" }) from workflow. Values are strings.',
  upsertMemo:
    'A memo has no run-level equivalent: keep it in workflow state, return it, or write it to a stream.',
  setDefaultSignalHandler:
    'A default signal handler has no equivalent: create a hook for each signal the workflow accepts.',
  setDefaultQueryHandler:
    'Queries have no equivalent: publish the state they read to a stream or run attributes.',
  setDefaultUpdateHandler:
    'Updates have no equivalent: receive the input through a hook and return the result through a stream or a hook.',
  defineQuery:
    'Queries have no equivalent: publish the state they read to a stream (getWritable()) or run attributes (setAttributes()).',
  defineUpdate:
    'Updates have no equivalent: receive the input through a hook and return the result through a stream or a second hook.',
  allHandlersFinished:
    'allHandlersFinished() has no equivalent: await the handler work explicitly before returning.',
  inWorkflowContext:
    'inWorkflowContext(): try getWorkflowMetadata(), which throws outside a workflow.',
  proxySinks: 'Sinks have no equivalent: log with console, or write to a step.',
  createEventGroup: 'Event groups have no equivalent.',
  setCurrentDetails:
    'Current details have no equivalent; use setAttributes() for searchable status.',
  getCurrentDetails: 'Current details have no equivalent.',
  workflowRandom:
    'Math.random() is already deterministic in a workflow function.',
  getRandomStream:
    'Math.random() is already deterministic in a workflow function.',
};

const ACTIVITY_GUIDANCE: Record<string, string> = {
  Context:
    'Context.current(): a step reads getStepMetadata() (stepId, attempt, stepStartedAt) and getWorkflowMetadata() (workflowRunId); it has no heartbeat or cancellation context.',
  activityInfo:
    'activityInfo(): a step reads getStepMetadata() (stepId, attempt, stepStartedAt) and getWorkflowMetadata() (workflowRunId).',
  info: 'Context.current().info: a step reads getStepMetadata() (stepId, attempt, stepStartedAt) and getWorkflowMetadata() (workflowRunId).',
  cancellationSignal:
    'Activity cancellation: create an AbortController in the workflow and pass its signal into the step as an argument.',
  cancelled:
    'Activity cancellation: create an AbortController in the workflow and pass its signal into the step as an argument.',
  sleep:
    'The activity sleep() waits inside the step: use `await new Promise((r) => setTimeout(r, ms))`, or move the wait to the workflow as sleep().',
  getClient:
    'A Temporal client inside an activity: use start(), getRun() or resumeHook() from workflow/api instead.',
};

function singleLine(text: string, max = 140): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max
    ? `${collapsed.slice(0, max - 3)}...`
    : collapsed;
}

/**
 * Project-wide pass: which activities each workflow file proxies, from which
 * module, with which retry policy.
 */
export function collectActivities(
  ts: typeof TS,
  program: TS.Program,
  files: string[]
): TemporalContext {
  const checker = program.getTypeChecker();
  const activities = new Map<string, Map<string, ActivityUse>>();
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf || !sf.text.includes('proxy')) continue;
    const visit = (node: TS.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isCallExpression(skipParens(ts, node.initializer))
      ) {
        const call = skipParens(ts, node.initializer) as TS.CallExpression;
        const callee = call.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : '';
        if (
          (name === 'proxyActivities' || name === 'proxyLocalActivities') &&
          call.typeArguments?.[0]
        ) {
          const module = moduleFileOf(ts, checker, call.typeArguments[0]);
          if (module) record(module, node, call, sf);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { activities };

  function record(
    module: string,
    decl: TS.VariableDeclaration,
    call: TS.CallExpression,
    sf: TS.SourceFile
  ) {
    const names: string[] = [];
    if (ts.isObjectBindingPattern(decl.name)) {
      for (const element of decl.name.elements) {
        const exported = element.propertyName
          ? propertyNameText(ts, element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : undefined;
        if (exported) names.push(exported);
      }
    } else if (ts.isIdentifier(decl.name)) {
      // `acts.greet()`: every property read off the proxy.
      const symbol = checker.getSymbolAtLocation(decl.name);
      const visit = (node: TS.Node): void => {
        if (
          ts.isPropertyAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          checker.getSymbolAtLocation(node.expression) === symbol
        ) {
          names.push(node.name.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    const opts = call.arguments[0];
    let maxRetries: number | undefined;
    const notes: string[] = [];
    if (opts && ts.isObjectLiteralExpression(opts)) {
      const retry = getProperty(ts, opts, 'retry');
      if (retry && ts.isObjectLiteralExpression(retry)) {
        const attempts = getProperty(ts, retry, 'maximumAttempts');
        if (attempts && ts.isNumericLiteral(attempts)) {
          const n = Number(attempts.text);
          // 0 means unlimited in Temporal.
          if (n >= 1) maxRetries = n - 1;
        }
        const tuning = retry.properties
          .map((p) => p.name && propertyNameText(ts, p.name))
          .filter(
            (k): k is string =>
              !!k &&
              [
                'initialInterval',
                'backoffCoefficient',
                'maximumInterval',
              ].includes(k)
          );
        if (tuning.length) {
          notes.push(
            `The retry ${tuning.map((t) => `\`${t}\``).join(', ')} settings have no equivalent: the Workflow SDK backs off on its own. Throw RetryableError with \`retryAfter\` from the step to choose the delay.`
          );
        }
        if (getProperty(ts, retry, 'nonRetryableErrorTypes')) {
          notes.push(
            '`nonRetryableErrorTypes` has no equivalent: throw FatalError from the step for errors that must not be retried.'
          );
        }
      }
    }
    const from = sf.fileName.split('/').pop() ?? sf.fileName;
    let map = activities.get(module);
    if (!map) {
      map = new Map();
      activities.set(module, map);
    }
    for (const name of names) {
      const existing = map.get(name);
      if (existing) {
        if (existing.maxRetries !== maxRetries) existing.conflict = true;
        for (const n of notes)
          if (!existing.notes.includes(n)) existing.notes.push(n);
      } else {
        map.set(name, { maxRetries, notes: [...notes], from });
      }
    }
  }
}

function moduleFileOf(
  ts: typeof TS,
  checker: TS.TypeChecker,
  typeArg: TS.TypeNode
): string | undefined {
  let symbol: TS.Symbol | undefined;
  if (ts.isTypeQueryNode(typeArg) && ts.isIdentifier(typeArg.exprName)) {
    symbol = checker.getSymbolAtLocation(typeArg.exprName);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        symbol = undefined;
      }
    }
  } else if (ts.isImportTypeNode(typeArg)) {
    symbol = checker.getTypeFromTypeNode(typeArg).getSymbol();
  }
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return declaration && ts.isSourceFile(declaration)
    ? declaration.fileName
    : undefined;
}
