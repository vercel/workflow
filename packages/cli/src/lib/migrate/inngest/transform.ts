import type * as TS from 'typescript';
import {
  detectIndentUnit,
  EditSet,
  indentAt,
  lineOf,
  lineStartOf,
} from '../edits.js';
import { camelCaseIdentifier, NameAllocator } from '../names.js';
import type {
  CapturedVariable,
  FileReport,
  FunctionTrigger,
  MigratedFunction,
  MigratedHook,
  MigrationNote,
} from './report-types.js';

/**
 * Inngest -> Workflow SDK codemod for one file.
 *
 * The heart of it is lifting `step.run(id, closure)` into a module-level
 * `"use step"` function. A closure can read anything in scope; a step
 * function cannot, because its arguments are serialized into the event log.
 * So every binding the closure reads from the Inngest handler (handler
 * parameters, earlier step results, loop variables) is found with the
 * TypeScript binder, becomes a parameter of the new step function, and is
 * passed at the call site. Bindings declared at module scope stay as they
 * are: a module-level step function still sees them.
 *
 * Anything the codemod cannot rewrite without changing behavior is left in
 * place with a `TODO(workflow-migrate)` comment and reported, rather than
 * guessed at. Examples: a closure that assigns to a captured variable (the
 * write would be lost once the variable is passed by value), a closure that
 * captures a local function (functions are not serializable), or a
 * `step.waitForEvent()` with a CEL `if` expression.
 */

export const TODO_TAG = 'TODO(workflow-migrate)';

/** Wrap a type annotation that a later pass validates against the checker. */
export const TYPE_START = '/*@wf:t*/';
export const TYPE_END = '/*@wf:/t*/';
/** Placeholder after a generated parameter whose type a later pass infers. */
export const INFER_MARK = '/*@wf:infer*/';

export interface TransformOptions {
  ts: typeof TS;
  sourceFile: TS.SourceFile;
  checker: TS.TypeChecker;
  /** File name for the report (usually relative to the project root). */
  reportName: string;
  /**
   * Identifiers known to hold an Inngest client anywhere in the project, so
   * `inngest.send()` calls in files without a function are still reported.
   */
  clientNames?: ReadonlySet<string>;
}

export interface TransformResult {
  code: string;
  report: FileReport;
}

type FunctionLike = TS.ArrowFunction | TS.FunctionExpression;

interface StepToolCall {
  call: TS.CallExpression;
  /** `run`, `sleep`, `ai.wrap`, ... */
  method: string;
}

interface Region {
  start: number;
  end: number;
  from: string;
  to: string;
}

interface HandlerInfo {
  handler: FunctionLike;
  /** Symbols that hold the step tools (`step`, an alias, or the global). */
  stepSymbols: Set<TS.Symbol>;
  /** The handler's single `ctx` parameter, when it is not destructured. */
  ctxSymbol?: TS.Symbol;
  /** Parameter list of the workflow function, e.g. `event` or `{ data }`. */
  eventParam?: string;
  /** Node whose type is the event type, for the annotation. */
  eventTypeNode?: TS.Node;
  /** Symbol bound to the event, when the event is a plain identifier. */
  eventSymbol?: TS.Symbol;
  /** Binding -> replacement expression (runId, logger, attempt). */
  replacements: Map<TS.Symbol, { text: () => string; stepOnly?: boolean }>;
  /** Handler-context properties with no equivalent, by binding symbol. */
  unsupported: Map<TS.Symbol, string>;
}

const STEP_METHODS = new Set([
  'run',
  'sleep',
  'sleepUntil',
  'waitForEvent',
  'waitForSignal',
  'invoke',
  'sendEvent',
  'sendSignal',
  'fetch',
  'ai.wrap',
  'ai.infer',
  'realtime.publish',
]);

/** Inngest function options and what to do about them. */
const CONFIG_GUIDANCE: Record<string, string> = {
  concurrency:
    'Inngest `concurrency` has no function-level equivalent. Limit concurrency where you call start(), or inside the steps that need it.',
  throttle:
    'Inngest `throttle` has no function-level equivalent. Throttle where you call start().',
  rateLimit:
    'Inngest `rateLimit` has no function-level equivalent. Rate-limit where you call start().',
  debounce:
    'Inngest `debounce` has no function-level equivalent. Debounce where you call start(), for example with a hook keyed by the debounce key.',
  batchEvents:
    'Inngest `batchEvents` has no equivalent. Batch events before calling start(), or start one run per event.',
  priority:
    'Inngest `priority` has no equivalent. Runs start in the order start() is called.',
  timeouts:
    'Inngest `timeouts` has no equivalent. Race the work against sleep() inside the workflow, or cancel the run with run.cancel().',
  cancelOn:
    'Inngest `cancelOn` has no declarative equivalent. Call getRun(runId).cancel() where you sent the cancel event, or race the work against a hook and pass an AbortSignal into the steps.',
  onFailure:
    'Inngest `onFailure` has no declarative equivalent. Wrap the workflow body in try/catch and call a cleanup step in the catch block, then rethrow.',
  middleware:
    'Inngest middleware does not run in the Workflow SDK. Move what it did into steps.',
  singleton:
    'Inngest `singleton` maps to start(workflow, [event], { experimental_hook: { token } }) with no retention: one run per token at a time, HookConflictError for an overlapping start. For mode "skip", catch it; for mode "cancel", cancel getRun(error.conflictingRunId) and start again.',
  idempotency:
    'Inngest `idempotency` maps to an idempotent start: start(workflow, [event], { experimental_hook: { token, experimental_minRetention: "24h" } }).',
};

const IGNORED_CONFIG = new Set([
  'id',
  'name',
  'description',
  'retries',
  'triggers',
  'checkpointing',
  'optimizeParallelism',
]);

export function transformInngestFile(
  options: TransformOptions
): TransformResult {
  const { ts, sourceFile: sf, checker } = options;
  const text = sf.text;
  const edits = new EditSet(text);
  const typed = isTypeScriptFile(sf.fileName);
  const indentUnit = detectIndentUnit(text);
  const quote = detectQuote(sf);
  const semi = detectSemicolons(sf) ? ';' : '';
  const report: FileReport = {
    file: options.reportName,
    changed: false,
    functions: [],
    notes: [],
    boundary: [],
  };

  const allIdentifiers = new Set<string>();
  const templateRanges: Array<[number, number]> = [];
  const visitAll = (node: TS.Node): void => {
    if (ts.isIdentifier(node)) allIdentifiers.add(node.text);
    if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      templateRanges.push([node.getStart(sf), node.end]);
    }
    ts.forEachChild(node, visitAll);
  };
  visitAll(sf);
  const names = new NameAllocator(allIdentifiers);

  const workflowImports = new Set<string>();
  const apiImports = new Set<string>();
  const errorsImports = new Set<string>();

  // Names bound anywhere in the file. A Workflow API imported under one of
  // them would collide with (or be shadowed by) the existing binding, so it
  // is imported under an alias instead. A binding that already imports the
  // same API from `workflow` is reused.
  const declaredNames = new Map<string, string | undefined>();
  const collectDeclared = (node: TS.Node): void => {
    if (ts.isIdentifier(node) && isDeclarationName(ts, node)) {
      let from: string | undefined;
      const specifier = node.parent;
      if (ts.isImportSpecifier(specifier)) {
        const decl = specifier.parent.parent.parent;
        if (
          ts.isImportDeclaration(decl) &&
          ts.isStringLiteral(decl.moduleSpecifier)
        ) {
          from = `${decl.moduleSpecifier.text}:${(specifier.propertyName ?? specifier.name).text}`;
        }
      }
      declaredNames.set(
        node.text,
        declaredNames.has(node.text) ? undefined : from
      );
    }
    ts.forEachChild(node, collectDeclared);
  };
  collectDeclared(sf);
  const aliases = new Map<string, string>();
  /** Local name for `name` imported from `module`; registers the import. */
  const use = (
    module: 'workflow' | 'workflow/api' | 'workflow/errors',
    name: string
  ): string => {
    const key = `${module}:${name}`;
    const known = aliases.get(key);
    if (known) return known;
    const preferred = name === 'fetch' ? 'workflowFetch' : name;
    let local = preferred;
    const taken = (candidate: string) =>
      declaredNames.has(candidate) && declaredNames.get(candidate) !== key;
    if (taken(local) || (local !== name && allIdentifiers.has(local))) {
      const base =
        name === 'fetch'
          ? 'workflowFetch'
          : `workflow${name[0].toUpperCase()}${name.slice(1)}`;
      local = base;
      for (
        let n = 2;
        declaredNames.has(local) || allIdentifiers.has(local);
        n++
      )
        local = `${base}${n}`;
    }
    names.reserve(local);
    aliases.set(key, local);
    (module === 'workflow'
      ? workflowImports
      : module === 'workflow/api'
        ? apiImports
        : errorsImports
    ).add(local === name ? name : `${name} as ${local}`);
    return local;
  };
  const wf = (name: string) => use('workflow', name);
  /** Same as `use`, for a type-only import (TypeScript files only). */
  const typeImport = (name: string): string => {
    const key = `workflow:type:${name}`;
    const known = aliases.get(key);
    if (known) return known;
    let local = name;
    for (
      let n = 2;
      declaredNames.has(local) &&
      declaredNames.get(local) !== `workflow:${name}`;
      n++
    )
      local = `Workflow${name}${n}`;
    names.reserve(local);
    aliases.set(key, local);
    workflowImports.add(
      local === name ? `type ${name}` : `type ${name} as ${local}`
    );
    return local;
  };
  /** Module-level helpers the generated code calls, appended to the file. */
  const helpers: Array<() => string> = [];
  let waitHelperName: string | undefined;
  /** Local name of HookForceClaimedError, once a wait takes over its token. */
  let forceClaimedError: string | undefined;

  // Ranges whose original references are dropped from the output, and the
  // sub-ranges re-rendered inside them. Used to tell whether an import is
  // still referenced once the edits are applied.
  const droppedRanges: Array<[number, number]> = [];
  const keptRanges: Array<[number, number]> = [];

  const regions: Region[] = [];

  const line = (node: TS.Node | number) =>
    lineOf(text, typeof node === 'number' ? node : node.getStart(sf));

  const symbolOf = (node: TS.Node): TS.Symbol | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol;
  };

  /** Statement (in a statement list) that contains `node`. */
  const statementOf = (node: TS.Node): TS.Statement | undefined => {
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
        ts.isStatement(current as TS.Node)
      ) {
        return current as TS.Statement;
      }
      current = parent;
    }
    return undefined;
  };

  const todoStatements = new Map<number, string[]>();
  /** Leave `node` in place with a TODO comment above its statement. */
  const addTodo = (
    node: TS.Node,
    message: string,
    notes: MigrationNote[]
  ): void => {
    notes.push({ severity: 'todo', line: line(node), message });
    const statement = statementOf(node);
    if (!statement) return;
    const pos = statement.getStart(sf);
    const list = todoStatements.get(pos) ?? [];
    if (!list.includes(message)) list.push(message);
    todoStatements.set(pos, list);
  };

  // --- Imports from `inngest` -------------------------------------------

  const errorRenames = new Map<TS.Symbol, 'FatalError' | 'RetryableError'>();
  const globalStepSymbols = new Set<TS.Symbol>();
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (specifier !== 'inngest' && !specifier.startsWith('inngest/')) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      const symbol = symbolOf(element.name);
      if (!symbol) continue;
      if (imported === 'NonRetriableError')
        errorRenames.set(symbol, 'FatalError');
      if (imported === 'RetryAfterError')
        errorRenames.set(symbol, 'RetryableError');
      if (imported === 'step' && specifier === 'inngest') {
        globalStepSymbols.add(symbol);
      }
    }
  }

  // --- Find `client.createFunction(...)` --------------------------------

  const createCalls: TS.CallExpression[] = [];
  const findCreate = (node: TS.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'createFunction' &&
      node.arguments.length >= 2
    ) {
      if (isFunctionLike(ts, node.arguments[node.arguments.length - 1])) {
        createCalls.push(node);
        return;
      }
      report.notes.push({
        severity: 'todo',
        line: line(node),
        message:
          'createFunction() is given its handler by reference, so it was not migrated. Inline the handler (or migrate the referenced function by hand: it becomes the "use workflow" function).',
      });
    }
    ts.forEachChild(node, findCreate);
  };
  findCreate(sf);

  const clientNames = new Set(options.clientNames ?? []);
  for (const call of createCalls) {
    const receiver = (call.expression as TS.PropertyAccessExpression)
      .expression;
    if (ts.isIdentifier(receiver)) clientNames.add(receiver.text);
  }

  for (const call of createCalls) {
    const result = migrateFunction(call);
    if (result) {
      report.functions.push(result);
    }
  }

  function migrateFunction(
    call: TS.CallExpression
  ): MigratedFunction | undefined {
    const handler = call.arguments[call.arguments.length - 1] as FunctionLike;
    const configArg = call.arguments[0];
    // The config may be a const declared elsewhere in the file.
    const resolvedConfig = configArg && resolveConst(configArg);
    const config =
      resolvedConfig && ts.isObjectLiteralExpression(resolvedConfig)
        ? resolvedConfig
        : undefined;
    const idNode = config && getProperty(ts, config, 'id');
    const inngestId = idNode
      ? literalText(ts, resolveConst(idNode))
      : undefined;

    const fnNotes: MigrationNote[] = [];
    const fn: MigratedFunction = {
      inngestId,
      workflowName: '',
      line: line(call),
      triggers: [],
      steps: [],
      hooks: [],
      notes: fnNotes,
      config: {},
    };

    // Only module-level functions can become workflows.
    if (enclosingFunction(ts, call)) {
      report.notes.push({
        severity: 'todo',
        line: line(call),
        message:
          'createFunction() is called inside another function. Workflow functions must be declared at module scope, so this function was not migrated.',
      });
      return undefined;
    }

    const shape = statementShape(call);
    if (!shape) {
      report.notes.push({
        severity: 'todo',
        line: line(call),
        message:
          'createFunction() is not assigned to a variable or exported as default, so it was not migrated. Assign it to a const and run the codemod again.',
      });
      return undefined;
    }

    if (handler.asteriskToken) {
      report.notes.push({
        severity: 'todo',
        line: line(handler),
        message:
          'Generator handlers are not supported; migrate this one by hand.',
      });
      return undefined;
    }

    // Triggers: v3 passes them as the second argument, v4 as `triggers`.
    const triggerNodes: TS.Expression[] = [];
    if (call.arguments.length >= 3) triggerNodes.push(call.arguments[1]);
    const v4Triggers = config && getProperty(ts, config, 'triggers');
    if (v4Triggers) triggerNodes.push(resolveConst(v4Triggers));
    for (const node of triggerNodes) {
      fn.triggers.push(...readTriggers(node));
    }

    const workflowName =
      shape.name ??
      names.allocate(
        camelCaseIdentifier(inngestId ?? '') ?? 'workflow',
        'Workflow'
      );
    if (shape.name) names.reserve(shape.name);
    fn.workflowName = workflowName;

    const retriesNode = config && getProperty(ts, config, 'retries');
    const retriesValue = retriesNode && resolveConst(retriesNode);
    const retries =
      retriesValue && ts.isNumericLiteral(retriesValue)
        ? Number(retriesValue.text)
        : undefined;

    // Function-level config without an equivalent.
    const configTodos: string[] = [];
    // Config the codemod cannot read is a blocker, not a silent default:
    // the retry count, triggers and flow control would otherwise be lost.
    if (configArg && !config) {
      const message = `The function options (\`${singleLine(configArg.getText(sf), 80)}\`) are not an object literal the codemod can read, so its retries, triggers and flow-control options were not migrated. Set \`maxRetries\` on each step and move the rest by hand.`;
      configTodos.push(message);
      fnNotes.push({ severity: 'todo', line: line(configArg), message });
    }
    if (config?.properties.some((p) => ts.isSpreadAssignment(p))) {
      const message =
        'The function options spread another object, which the codemod does not read. Check it for retries, triggers and flow-control options and migrate them by hand.';
      configTodos.push(message);
      fnNotes.push({ severity: 'todo', line: line(config), message });
    }
    if (retriesNode && retries === undefined) {
      const message = `\`retries: ${singleLine(retriesNode.getText(sf), 80)}\` is not a number the codemod can read. Set \`stepFunction.maxRetries\` on each step by hand (the Workflow SDK default is 3).`;
      configTodos.push(message);
      fnNotes.push({ severity: 'todo', line: line(retriesNode), message });
    }
    // An `onFailure` handler is code, not config: keep it, under a name.
    let onFailure:
      | { name: string; node: TS.Expression; message: string }
      | undefined;
    if (config) {
      for (const property of config.properties) {
        const key = property.name && propertyNameText(ts, property.name);
        if (!key || IGNORED_CONFIG.has(key)) continue;
        const guidance = CONFIG_GUIDANCE[key];
        const valueText = ts.isPropertyAssignment(property)
          ? property.initializer.getText(sf)
          : property.getText(sf);
        fn.config[key] = valueText;
        if (
          key === 'onFailure' &&
          ts.isPropertyAssignment(property) &&
          isFunctionLike(ts, skipParens(ts, property.initializer))
        ) {
          const message = `${guidance} The Inngest handler is kept here as \`${names.allocate(`${shape.name ?? camelCaseIdentifier(inngestId ?? '') ?? 'workflow'}OnFailure`, '')}\`: migrate its step calls and call it from the catch block.`;
          const name = /`([^`]+)`: migrate/.exec(message)?.[1] ?? 'onFailure';
          onFailure = { name, node: property.initializer, message };
          const start = property.initializer.getStart(sf);
          keptRanges.push([start, property.initializer.end]);
          regions.push({
            start,
            end: property.initializer.end,
            from: indentAt(text, property.getStart(sf)),
            to: '',
          });
          fnNotes.push({ severity: 'todo', line: line(property), message });
          continue;
        }
        const message = guidance
          ? `${guidance} (was: ${key}: ${singleLine(valueText, 400)})`
          : `Inngest option \`${key}\` was dropped. (was: ${singleLine(valueText, 400)})`;
        configTodos.push(message);
        fnNotes.push({ severity: 'todo', line: line(property), message });
      }
    }
    for (const trigger of fn.triggers) {
      if (trigger.kind === 'cron') {
        const message = `Inngest ran this function on the cron schedule ${trigger.value}. Call start(${workflowName}, [...]) from a scheduled job (for example a Vercel Cron Job route) to keep the schedule.`;
        configTodos.push(message);
        fnNotes.push({ severity: 'todo', line: line(call), message });
      }
    }

    const info = analyzeHandler(handler, fnNotes);
    if (!info) return undefined;

    // Collect the step tool calls in the handler.
    const stepCalls: StepToolCall[] = [];
    const strayStepRefs: TS.Node[] = [];
    const visit = (node: TS.Node): void => {
      if (ts.isCallExpression(node)) {
        const method = stepMethod(node.expression, info);
        if (method) {
          stepCalls.push({ call: node, method });
          // Visit the arguments (closures can hold more step calls, which
          // are flagged as nested below) but not the `step.x` callee.
          node.arguments.forEach(visit);
          return;
        }
      }
      if (isStepToolsRef(node, info)) {
        strayStepRefs.push(node);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(handler.body);

    // A step tool used other than as a direct call (passed to a helper,
    // destructured, stored) cannot be rewritten here.
    for (const ref of strayStepRefs) {
      const insideCall = stepCalls.some(
        (s) => ref.pos >= s.call.pos && ref.end <= s.call.end
      );
      if (insideCall) continue;
      addTodo(
        ref,
        'Inngest step tools are used here other than as a direct `step.*()` call (for example passed to a helper). Migrate the step calls in that code by hand: each `step.run()` becomes a "use step" function.',
        fnNotes
      );
    }

    // Steps nested inside another step's closure are an Inngest error; flag
    // the outer one and leave both alone.
    const runCalls = stepCalls.filter(
      (s) => s.method === 'run' || s.method === 'ai.wrap'
    );
    const nestedOuter = new Set<TS.CallExpression>();
    const nestedInner = new Set<TS.CallExpression>();
    for (const outer of runCalls) {
      for (const inner of stepCalls) {
        if (
          inner !== outer &&
          inner.call.pos >= outer.call.pos &&
          inner.call.end <= outer.call.end
        ) {
          nestedInner.add(inner.call);
          nestedOuter.add(outer.call);
        }
      }
    }

    const handlerBody = handler.body;
    const bodyRange = blockContentRange(handlerBody);
    keptRanges.push(bodyRange);

    const liftedFunctions: Array<() => string> = [];
    const stepBodyRanges: Array<[number, number]> = [];

    for (const stepCall of stepCalls) {
      if (nestedInner.has(stepCall.call)) continue;
      if (nestedOuter.has(stepCall.call)) {
        addTodo(
          stepCall.call,
          'A step tool is called inside another step closure, which Inngest does not support either. Move the inner call out to the handler.',
          fnNotes
        );
        continue;
      }
      migrateStepCall(
        stepCall,
        info,
        fn,
        retries,
        liftedFunctions,
        stepBodyRanges
      );
    }

    // References to handler-context bindings (runId, logger, attempt).
    applyContextReplacements(handler, info, fn, stepBodyRanges);
    checkWorkflowBody(
      handler,
      info,
      fn,
      stepCalls.map((s) => s.call)
    );

    // Indentation: the handler body moves to the top level.
    const bodyFrom = contentIndent(handlerBody);
    regions.push({
      start: bodyRange[0],
      end: bodyRange[1],
      from: bodyFrom,
      to: indentUnit,
    });

    // Replace the whole statement.
    const statementNode = shape.statement;
    droppedRanges.push([statementNode.getStart(sf), statementNode.end]);
    fnNotes.sort((a, b) => a.line - b.line);

    // A synchronous handler becomes an async workflow; nothing else changes.
    edits.add(statementNode.getStart(sf), statementNode.end, () => {
      const parts: string[] = [];
      const header = configTodos
        .map((todo) => `// ${TODO_TAG}: ${todo}\n`)
        .join('');
      if (onFailure) {
        parts.push(
          `// ${TODO_TAG}: ${onFailure.message}\nconst ${onFailure.name} = ${renderNode(onFailure.node)}${semi}`
        );
      }
      const exportPrefix = shape.exported
        ? shape.isDefault
          ? 'export default '
          : 'export '
        : '';
      let param = info.eventParam ?? '';
      if (param && typed) {
        const annotation = eventAnnotation(info);
        if (annotation === 'any') param += ': any';
        else if (annotation) param += `: ${TYPE_START}${annotation}${TYPE_END}`;
      }
      const prelude = info.unsupported.size
        ? [...new Set(info.unsupported.values())].map(
            (message) => `${indentUnit}// ${TODO_TAG}: ${message}`
          )
        : [];
      const body = renderBody(handlerBody);
      parts.push(
        `${header}${exportPrefix}async function ${workflowName}(${param}) {\n` +
          `${indentUnit}${quote}use workflow${quote}${semi}\n` +
          (prelude.length ? `${prelude.join('\n')}\n` : '') +
          (body ? `${body}\n` : '') +
          '}'
      );
      for (const lifted of liftedFunctions) parts.push(lifted());
      return parts.join('\n\n');
    });

    return fn;
  }

  /** `{ ... }` body -> its re-indented statements; expression body -> `return`. */
  function renderBody(body: TS.ConciseBody): string {
    if (ts.isBlock(body)) {
      const [start, end] = blockContentRange(body);
      return trimRendered(edits.render(start, end), indentUnit);
    }
    // `() => ({ ... })` returns the object literal; `return` needs no parens.
    const inner = skipParens(ts, body);
    const expr = ts.isObjectLiteralExpression(inner) ? inner : body;
    const rendered = edits.render(expr.getStart(sf), expr.end);
    return `${indentUnit}return ${rendered}${semi}`;
  }

  function blockContentRange(body: TS.ConciseBody): [number, number] {
    if (ts.isBlock(body)) {
      return [body.getStart(sf) + 1, body.end - 1];
    }
    return [body.getStart(sf), body.end];
  }

  /** Indentation of the first line of a body's content. */
  function contentIndent(body: TS.ConciseBody): string {
    if (ts.isBlock(body) && body.statements.length > 0) {
      return indentAt(text, body.statements[0].getStart(sf));
    }
    if (ts.isBlock(body)) {
      return indentAt(text, body.getStart(sf)) + indentUnit;
    }
    return indentAt(text, body.getStart(sf));
  }

  function analyzeHandler(
    handler: FunctionLike,
    notes: MigrationNote[]
  ): HandlerInfo | undefined {
    const info: HandlerInfo = {
      handler,
      stepSymbols: new Set(globalStepSymbols),
      replacements: new Map(),
      unsupported: new Map(),
    };
    const param = handler.parameters[0];
    if (!param) return info;
    if (handler.parameters.length > 1) {
      notes.push({
        severity: 'info',
        line: line(handler),
        message:
          'Only the first handler parameter (the Inngest context) was read.',
      });
    }

    if (ts.isObjectBindingPattern(param.name)) {
      for (const element of param.name.elements) {
        if (element.dotDotDotToken) {
          const symbol = ts.isIdentifier(element.name)
            ? symbolOf(element.name)
            : undefined;
          if (symbol) {
            info.unsupported.set(
              symbol,
              `\`...${element.name.getText(sf)}\` collected the rest of the Inngest context, which no longer exists.`
            );
          }
          continue;
        }
        const key = element.propertyName
          ? propertyNameText(ts, element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : undefined;
        if (!key) continue;
        const symbol = ts.isIdentifier(element.name)
          ? symbolOf(element.name)
          : undefined;
        switch (key) {
          case 'step':
            if (symbol) info.stepSymbols.add(symbol);
            else {
              notes.push({
                severity: 'todo',
                line: line(element),
                message:
                  'The step tools are destructured further in the handler signature; destructure `step` itself and run the codemod again.',
              });
            }
            break;
          case 'event':
            info.eventParam = element.name.getText(sf);
            info.eventTypeNode = element.name;
            info.eventSymbol = symbol;
            break;
          case 'runId':
            if (symbol) {
              info.replacements.set(symbol, {
                text: () => `${wf('getWorkflowMetadata')}().workflowRunId`,
              });
            }
            break;
          case 'logger':
            if (symbol)
              info.replacements.set(symbol, { text: () => 'console' });
            break;
          case 'attempt':
            if (symbol) {
              info.replacements.set(symbol, {
                text: () => `(${wf('getStepMetadata')}().attempt - 1)`,
                stepOnly: true,
              });
            }
            break;
          case 'events':
            if (symbol) {
              info.unsupported.set(
                symbol,
                '`events` held a batch of Inngest events. Start one run per event, or pass the batch as an argument to start().'
              );
            }
            break;
          default:
            if (symbol) {
              info.unsupported.set(
                symbol,
                `\`${key}\` came from the Inngest handler context (or middleware) and has no direct equivalent. Provide it another way.`
              );
            }
        }
      }
      return info;
    }

    if (ts.isIdentifier(param.name)) {
      info.ctxSymbol = symbolOf(param.name);
      // `ctx.event` becomes the workflow parameter.
      let eventNode: TS.Node | undefined;
      const find = (node: TS.Node): void => {
        if (
          !eventNode &&
          ts.isPropertyAccessExpression(node) &&
          node.name.text === 'event' &&
          ts.isIdentifier(node.expression) &&
          symbolOf(node.expression) === info.ctxSymbol
        ) {
          eventNode = node;
        }
        ts.forEachChild(node, find);
      };
      find(handler.body);
      if (eventNode) {
        info.eventParam = allocateLocal(handler, 'event');
        info.eventTypeNode = eventNode;
      }
      return info;
    }

    notes.push({
      severity: 'todo',
      line: line(param),
      message:
        'The handler context is destructured with a pattern the codemod does not understand.',
    });
    return info;
  }

  /** A name for a new local in `scope` that shadows nothing it references. */
  function allocateLocal(scope: TS.Node, base: string): string {
    const used = new Set<string>();
    const collect = (node: TS.Node): void => {
      if (ts.isIdentifier(node) && !isNonReferenceName(ts, node))
        used.add(node.text);
      ts.forEachChild(node, collect);
    };
    collect(scope);
    if (!used.has(base)) return base;
    let n = 2;
    while (used.has(`${base}${n}`)) n++;
    return `${base}${n}`;
  }

  function isStepToolsRef(node: TS.Node, info: HandlerInfo): boolean {
    if (ts.isIdentifier(node)) {
      if (
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.name === node
      ) {
        return false;
      }
      // The binding element declaring `step` is not a use.
      if (ts.isBindingElement(node.parent)) return false;
      const symbol = symbolOf(node);
      return !!symbol && info.stepSymbols.has(symbol);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'step' &&
      info.ctxSymbol &&
      ts.isIdentifier(node.expression) &&
      symbolOf(node.expression) === info.ctxSymbol
    ) {
      return true;
    }
    return false;
  }

  function stepMethod(
    callee: TS.Expression,
    info: HandlerInfo
  ): string | undefined {
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    if (isStepToolsRef(callee.expression, info)) {
      return callee.name.text;
    }
    if (
      ts.isPropertyAccessExpression(callee.expression) &&
      isStepToolsRef(callee.expression.expression, info)
    ) {
      return `${callee.expression.name.text}.${callee.name.text}`;
    }
    return undefined;
  }

  function migrateStepCall(
    stepCall: StepToolCall,
    info: HandlerInfo,
    fn: MigratedFunction,
    retries: number | undefined,
    lifted: Array<() => string>,
    stepBodyRanges: Array<[number, number]>
  ): void {
    const { call, method } = stepCall;
    const notes = fn.notes;
    const args = call.arguments;

    if (!STEP_METHODS.has(method)) {
      addTodo(
        call,
        `\`step.${method}()\` has no Workflow SDK equivalent the codemod knows about.`,
        notes
      );
      return;
    }

    switch (method) {
      case 'run':
      case 'ai.wrap':
        liftStep(stepCall, info, fn, retries, lifted, stepBodyRanges);
        return;
      case 'sleep': {
        if (args.length < 2) break;
        const sleep = wf('sleep');
        replaceCall(call, () => `${sleep}(${renderNode(args[1])})`, [args[1]]);
        return;
      }
      case 'sleepUntil': {
        if (args.length < 2) break;
        const sleep = wf('sleep');
        const time = args[1];
        const isDate =
          ts.isNewExpression(time) &&
          ts.isIdentifier(time.expression) &&
          time.expression.text === 'Date';
        replaceCall(
          call,
          () =>
            isDate
              ? `${sleep}(${renderNode(time)})`
              : `${sleep}(new Date(${renderNode(time)}))`,
          [time]
        );
        return;
      }
      case 'waitForEvent':
        migrateWaitForEvent(call, info, fn);
        return;
      case 'waitForSignal':
        migrateWaitForSignal(call, fn);
        return;
      case 'invoke':
        migrateInvoke(call, fn);
        return;
      case 'fetch': {
        const workflowFetch = wf('fetch');
        replaceCall(
          call,
          () => `${workflowFetch}(${args.map(renderNode).join(', ')})`,
          [...args]
        );
        return;
      }
      case 'sendEvent':
        addTodo(
          call,
          '`step.sendEvent()` published to the Inngest event bus. Call start(otherWorkflow, [event]) for each workflow the event triggered, or resumeHook(token, event) for a run waiting on it.',
          notes
        );
        return;
      case 'sendSignal':
        addTodo(
          call,
          '`step.sendSignal()` maps to resumeHook(signal, { signal, data }) called from inside a "use step" function.',
          notes
        );
        return;
      case 'ai.infer':
        addTodo(
          call,
          '`step.ai.infer()` offloaded the model call to Inngest. Call the model from a "use step" function instead (for example with the AI SDK).',
          notes
        );
        return;
      case 'realtime.publish':
        addTodo(
          call,
          '`step.realtime.publish()` maps to getWritable(): get the stream in the workflow and write to it inside a "use step" function.',
          notes
        );
        return;
    }
    addTodo(
      call,
      `This \`step.${method}()\` call has an unexpected shape.`,
      notes
    );
  }

  /** Replace `call` with generated text; `kept` are rendered sub-ranges. */
  function replaceCall(
    call: TS.Node,
    render: () => string,
    kept: TS.Node[]
  ): void {
    const start = call.getStart(sf);
    droppedRanges.push([start, call.end]);
    for (const node of kept) keptRanges.push([node.getStart(sf), node.end]);
    report.changed = true;
    edits.add(start, call.end, render);
  }

  function renderNode(node: TS.Node): string {
    return edits.render(node.getStart(sf), node.end);
  }

  function stepIdOf(idArg: TS.Expression | undefined): {
    id: string;
    dynamic: boolean;
    base?: string;
  } {
    if (!idArg) return { id: '', dynamic: true };
    let expr = idArg;
    if (ts.isObjectLiteralExpression(expr)) {
      const idProp = getProperty(ts, expr, 'id');
      if (idProp) expr = idProp;
    }
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return { id: expr.text, dynamic: false, base: expr.text };
    }
    if (ts.isTemplateExpression(expr)) {
      const staticText = [
        expr.head.text,
        ...expr.templateSpans.map((s) => s.literal.text),
      ].join(' ');
      return { id: expr.getText(sf), dynamic: true, base: staticText };
    }
    return { id: expr.getText(sf), dynamic: true };
  }

  function liftStep(
    stepCall: StepToolCall,
    info: HandlerInfo,
    fn: MigratedFunction,
    retries: number | undefined,
    lifted: Array<() => string>,
    stepBodyRanges: Array<[number, number]>
  ): void {
    const { call, method } = stepCall;
    const notes = fn.notes;
    const [idArg, fnArg, ...inputArgs] = call.arguments;
    const label = method === 'run' ? 'step.run' : 'step.ai.wrap';
    if (!fnArg) {
      addTodo(call, `\`${label}()\` without a function.`, notes);
      return;
    }
    const stepId = stepIdOf(idArg);
    const baseName =
      camelCaseIdentifier(stepId.base ?? '') ??
      (ts.isIdentifier(fnArg) ? fnArg.text : 'step');

    const closure = skipParens(ts, fnArg);

    // A reference to a function (e.g. `step.ai.wrap('id', generateText, opts)`)
    // becomes a thin step that calls it.
    if (!isFunctionLike(ts, closure)) {
      const root = rootIdentifier(ts, closure);
      const rootSymbol = root && symbolOf(root);
      const declaration = rootSymbol && firstDeclaration(rootSymbol);
      const isModuleLevel =
        !declaration ||
        declaration.getSourceFile() !== sf ||
        !isInside(declaration, info.handler);
      if (!root || !isModuleLevel || !isSimpleReference(ts, closure)) {
        addTodo(
          call,
          `\`${label}()\` was given a function the codemod cannot move to module scope. Wrap the call in a "use step" function by hand.`,
          notes
        );
        return;
      }
      const refText = closure.getText(sf);
      // The reference is copied into the new step, so its imports stay.
      keptRanges.push([closure.getStart(sf), closure.end]);
      if (
        method === 'ai.wrap' &&
        inlineAiWrap(call, refText, baseName, stepId, info, fn, retries, lifted)
      ) {
        return;
      }
      const name = names.allocate(baseName);
      const params = typed
        ? `...args: Parameters<typeof ${refText}>`
        : '...args';
      lifted.push(() => {
        let out =
          `async function ${name}(${params}) {\n` +
          `${indentUnit}${quote}use step${quote}${semi}\n` +
          `${indentUnit}return ${refText}(...args)${semi}\n` +
          '}';
        if (retries !== undefined)
          out += `\n${name}.maxRetries = ${retries}${semi}`;
        return out;
      });
      replaceCall(
        call,
        () => `${name}(${inputArgs.map(renderNode).join(', ')})`,
        inputArgs
      );
      fn.steps.push({
        stepId: stepId.id,
        dynamicId: stepId.dynamic,
        functionName: name,
        line: line(call),
        source: label,
        captured: [],
        inputs: inputArgs.length,
      });
      if (method === 'ai.wrap') {
        notes.push({
          severity: 'info',
          line: line(call),
          message: `\`${name}\` returns the model call's result, which must be serializable. Return only the fields you use (for example \`text\`), or move the agent loop to DurableAgent from @workflow/ai.`,
        });
      }
      return;
    }

    const fnNode = closure as FunctionLike;
    if (fnNode.asteriskToken) {
      addTodo(call, 'Generator step closures are not supported.', notes);
      return;
    }

    const analysis = analyzeCaptures(fnNode, info);
    if (analysis.blockers.length) {
      for (const blocker of analysis.blockers) addTodo(call, blocker, notes);
      return;
    }

    const name = names.allocate(baseName);
    const captured = analysis.captured;

    // Step body indentation.
    const bodyRange = blockContentRange(fnNode.body);
    keptRanges.push(bodyRange);
    stepBodyRanges.push(bodyRange);
    regions.push({
      start: bodyRange[0],
      end: bodyRange[1],
      from: contentIndent(fnNode.body),
      to: indentUnit,
    });

    // Parameters, type parameters and the return type are copied as text.
    for (const node of [
      ...fnNode.parameters,
      ...(fnNode.typeParameters ?? []),
      ...(fnNode.type ? [fnNode.type] : []),
    ]) {
      keptRanges.push([node.getStart(sf), node.end]);
    }
    const capturedParams = captured.map((c) =>
      typed ? `${c.name}${INFER_MARK}` : c.name
    );
    const ownParams = fnNode.parameters.map((p) => p.getText(sf));
    const allParams = [...capturedParams, ...ownParams].join(', ');
    const typeParams = fnNode.typeParameters
      ? `<${fnNode.typeParameters.map((p) => p.getText(sf)).join(', ')}>`
      : '';
    let returnType = '';
    if (typed && fnNode.type) {
      const typeText = fnNode.type.getText(sf);
      const isAsync = hasModifier(ts, fnNode, ts.SyntaxKind.AsyncKeyword);
      returnType = `: ${isAsync || /^Promise</.test(typeText) ? typeText : `Promise<${typeText}>`}`;
    }

    for (const note of analysis.warnings) {
      notes.push({ severity: 'info', line: line(call), message: note });
    }

    lifted.push(() => {
      const body = renderBody(fnNode.body);
      let out =
        `async function ${name}${typeParams}(${allParams})${returnType} {\n` +
        `${indentUnit}${quote}use step${quote}${semi}\n` +
        (body ? `${body}\n` : '') +
        '}';
      if (retries !== undefined)
        out += `\n${name}.maxRetries = ${retries}${semi}`;
      return out;
    });

    replaceCall(
      call,
      () =>
        `${name}(${[...captured.map((c) => c.argument), ...inputArgs.map(renderNode)].join(', ')})`,
      inputArgs
    );
    fn.steps.push({
      stepId: stepId.id,
      dynamicId: stepId.dynamic,
      functionName: name,
      line: line(call),
      source: label,
      captured: captured.map(({ name: n, declaredAt, kind }) => ({
        name: n,
        declaredAt,
        kind,
      })),
      inputs: inputArgs.length,
    });
  }

  /**
   * `step.ai.wrap(id, generateText, { model: openai('...'), prompt })` ->
   * a step that evaluates the inputs and calls the model itself, so the
   * model object never has to cross the step boundary. When the result is
   * destructured, the step returns only those fields, because an AI SDK
   * result is not serializable as a whole.
   */
  function inlineAiWrap(
    call: TS.CallExpression,
    refText: string,
    baseName: string,
    stepId: { id: string; dynamic: boolean },
    info: HandlerInfo,
    fn: MigratedFunction,
    retries: number | undefined,
    lifted: Array<() => string>
  ): boolean {
    const inputs = call.arguments.slice(2);
    let impure = false;
    const scan = (node: TS.Node): void => {
      if (ts.isAwaitExpression(node) || ts.isYieldExpression(node))
        impure = true;
      if (!impure) ts.forEachChild(node, scan);
    };
    inputs.forEach(scan);
    if (impure) return false;
    const analysis = analyzeCaptures(inputs, info);
    if (analysis.blockers.length) return false;

    // const { text, usage: u } = await step.ai.wrap(...)
    let picked: string[] | undefined;
    const awaited = call.parent;
    const declaration =
      awaited && ts.isAwaitExpression(awaited) ? awaited.parent : undefined;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      ts.isObjectBindingPattern(declaration.name)
    ) {
      const keys = declaration.name.elements.map((element) =>
        !element.dotDotDotToken &&
        !element.initializer &&
        ts.isIdentifier(element.name)
          ? propertyNameText(ts, element.propertyName ?? element.name)
          : undefined
      );
      if (keys.every((k): k is string => !!k && /^[A-Za-z_$][\w$]*$/.test(k)))
        picked = keys as string[];
    }

    const name = names.allocate(baseName);
    const captured = analysis.captured;
    for (const input of inputs)
      keptRanges.push([input.getStart(sf), input.end]);
    const inputIndent = inputs.length
      ? indentAt(text, inputs[0].getStart(sf))
      : '';
    for (const input of inputs) {
      regions.push({
        start: input.getStart(sf),
        end: input.end,
        from: inputIndent,
        to: indentUnit,
      });
    }
    lifted.push(() => {
      const callText = `${refText}(${inputs.map(renderNode).join(', ')})`;
      // Read the fields off a result local rather than destructuring them,
      // so a field named like a captured parameter cannot redeclare it.
      let result = 'result';
      for (let n = 2; allIdentifiers.has(result); n++) result = `result${n}`;
      const body = picked
        ? `${indentUnit}const ${result} = await ${callText}${semi}\n${indentUnit}return { ${picked.map((k) => `${k}: ${result}.${k}`).join(', ')} }${semi}`
        : `${indentUnit}return ${callText}${semi}`;
      const params = captured
        .map((c) => (typed ? `${c.name}${INFER_MARK}` : c.name))
        .join(', ');
      let out = `async function ${name}(${params}) {\n${indentUnit}${quote}use step${quote}${semi}\n${body}\n}`;
      if (retries !== undefined)
        out += `\n${name}.maxRetries = ${retries}${semi}`;
      return out;
    });
    replaceCall(
      call,
      () => `${name}(${captured.map((c) => c.argument).join(', ')})`,
      []
    );
    fn.steps.push({
      stepId: stepId.id,
      dynamicId: stepId.dynamic,
      functionName: name,
      line: line(call),
      source: 'step.ai.wrap',
      captured: captured.map(({ name: n, declaredAt, kind }) => ({
        name: n,
        declaredAt,
        kind,
      })),
      inputs: 0,
    });
    if (!picked) {
      fn.notes.push({
        severity: 'info',
        line: line(call),
        message: `\`${name}\` returns the whole result of \`${refText}()\`, which must be serializable. Return only the fields you use (for example \`text\`), or move the agent loop to DurableAgent from @workflow/ai.`,
      });
    }
    return true;
  }

  interface CaptureAnalysis {
    captured: Array<CapturedVariable & { argument: string }>;
    blockers: string[];
    warnings: string[];
  }

  /**
   * What a step body reads from the handler. `target` is the closure, or the
   * expressions that will be evaluated inside the new step (the inputs of
   * `step.ai.wrap()`).
   */
  function analyzeCaptures(
    target: FunctionLike | readonly TS.Expression[],
    info: HandlerInfo
  ): CaptureAnalysis {
    const result: CaptureAnalysis = {
      captured: [],
      blockers: [],
      warnings: [],
    };
    const roots: readonly TS.Node[] = isExpressionList(target)
      ? target
      : [target.body];
    const closure = isExpressionList(target) ? info.handler : target;
    const arrowLike = isExpressionList(target) || ts.isArrowFunction(target);
    const ownsDeclaration = (declaration: TS.Node) =>
      isExpressionList(target)
        ? roots.some((root) => isInside(declaration, root))
        : isInside(declaration, target);
    const seen = new Map<
      TS.Symbol | string,
      CapturedVariable & { argument: string }
    >();
    const handler = info.handler;

    const capture = (
      key: TS.Symbol | string,
      entry: CapturedVariable & { argument: string }
    ) => {
      if (!seen.has(key)) {
        seen.set(key, entry);
        result.captured.push(entry);
      }
    };

    const visit = (node: TS.Node): void => {
      if (
        arrowLike &&
        node.kind === ts.SyntaxKind.ThisKeyword &&
        !insideOwnThis(node, closure)
      ) {
        result.blockers.push(
          'The step closure uses `this` from the handler, which a module-level step function cannot see.'
        );
      }
      if (ts.isIdentifier(node)) {
        handleIdentifier(node);
      }
      // Type positions only matter when they name a type declared locally.
      ts.forEachChild(node, visit);
    };

    const handleIdentifier = (node: TS.Identifier): void => {
      if (isNonReferenceName(ts, node)) return;
      if (
        node.text === 'arguments' &&
        arrowLike &&
        !insideOwnArguments(node, closure)
      ) {
        result.blockers.push(
          'The step closure uses `arguments` from the handler.'
        );
        return;
      }
      let symbol: TS.Symbol | undefined;
      if (
        ts.isShorthandPropertyAssignment(node.parent) &&
        node.parent.name === node
      ) {
        symbol = checker.getShorthandAssignmentValueSymbol(node.parent);
      } else {
        symbol = symbolOf(node);
      }
      if (!symbol) return;

      // Context bindings handled by replacement are not captured.
      if (info.replacements.has(symbol)) return;
      if (info.stepSymbols.has(symbol)) {
        result.blockers.push(
          'The step closure uses the Inngest step tools itself (a nested step), which cannot be lifted.'
        );
        return;
      }
      if (info.unsupported.has(symbol)) {
        result.blockers.push(
          `The step closure uses \`${node.text}\` from the Inngest handler context. ${info.unsupported.get(symbol)}`
        );
        return;
      }

      // The `ctx` parameter: `ctx.event` is the workflow parameter.
      if (info.ctxSymbol && symbol === info.ctxSymbol) {
        const parent = node.parent;
        if (
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          parent.name.text === 'event' &&
          info.eventParam
        ) {
          capture('ctx.event', {
            name: info.eventParam,
            argument: info.eventParam,
            declaredAt: line(handler),
            kind: 'context',
          });
          return;
        }
        if (
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          (parent.name.text === 'runId' || parent.name.text === 'logger')
        ) {
          return; // replaced in place
        }
        result.blockers.push(
          'The step closure reads the Inngest context object directly; only `ctx.event`, `ctx.runId` and `ctx.logger` can be migrated.'
        );
        return;
      }

      const declaration = firstDeclaration(symbol);
      if (!declaration || declaration.getSourceFile() !== sf) return; // global or imported
      if (ownsDeclaration(declaration)) return; // the step body's own local
      if (!isInside(declaration, handler)) return; // module scope stays visible

      if (isTypeOnlyDeclaration(ts, declaration)) {
        result.blockers.push(
          `The step closure uses the type \`${node.text}\`, declared inside the handler. Move the type to module scope.`
        );
        return;
      }
      if (inTypePosition(ts, node)) return;

      if (isFunctionOrClassDeclaration(ts, declaration)) {
        result.blockers.push(
          `The step closure calls \`${node.text}\`, a function or class declared inside the handler. Functions are not serializable step arguments: move \`${node.text}\` to module scope and run the codemod again.`
        );
        return;
      }
      if (isAssignmentTarget(ts, node)) {
        result.blockers.push(
          `The step closure assigns to \`${node.text}\`, declared outside it. Passed as an argument, the write would be lost: return the new value from the step instead.`
        );
        return;
      }
      if (isMutatedProperty(ts, node)) {
        result.warnings.push(
          `\`${node.text}\` is modified inside the step. Step arguments are copies, so the change is not visible to the workflow (it was not reliable in Inngest either, where a memoized step does not run again). Return the value instead.`
        );
      }

      capture(symbol, {
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
    if (!isExpressionList(target)) {
      // Whole parameters: defaults and computed keys inside destructuring
      // patterns (`({ [field]: v, w = fallback }) => ...`) read the handler too.
      for (const param of target.parameters) visit(param);
    }
    // Deduplicate blockers.
    result.blockers = [...new Set(result.blockers)];
    result.warnings = [...new Set(result.warnings)];
    return result;
  }

  /**
   * Code outside the steps now runs in the workflow sandbox, which replays it
   * and has no I/O. Flag what will not work there.
   */
  function checkWorkflowBody(
    handler: FunctionLike,
    info: HandlerInfo,
    fn: MigratedFunction,
    stepCallNodes: TS.CallExpression[]
  ): void {
    const insideStepCall = (node: TS.Node) =>
      stepCallNodes.some(
        (call) => node.pos >= call.pos && node.end <= call.end
      );
    const extraEventFields = new Set<string>();
    const visit = (node: TS.Node): void => {
      if (
        !insideStepCall(node) &&
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'fetch' &&
        !symbolOf(node.expression)?.declarations?.some(
          (d) => d.getSourceFile() === sf
        )
      ) {
        addTodo(
          node,
          'The global fetch() is not available in a workflow function. Move this request into a "use step" function, or import { fetch } from "workflow" to make it a step.',
          fn.notes
        );
      }
      if (
        !insideStepCall(node) &&
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        clientNames.has(node.expression.text)
      ) {
        const member = node.name.text;
        const message =
          member === 'realtime'
            ? '`inngest.realtime.publish()` maps to getWritable(): get the stream in the workflow and write to it inside a "use step" function.'
            : member === 'send'
              ? '`inngest.send()` from inside a function maps to start(otherWorkflow, [event]) for a workflow the event triggered, or resumeHook(token, event) from a "use step" function for a run waiting on it.'
              : `\`${node.getText(sf)}\` calls the Inngest client from the workflow function, which cannot do I/O. Replace it, or move it into a "use step" function.`;
        addTodo(node, message, fn.notes);
      }
      if (
        info.eventSymbol &&
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        symbolOf(node.expression) === info.eventSymbol &&
        ['id', 'ts', 'user', 'v'].includes(node.name.text)
      ) {
        extraEventFields.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(handler.body);
    if (extraEventFields.size) {
      fn.notes.push({
        severity: 'info',
        line: line(handler),
        message: `The workflow reads ${[...extraEventFields].map((f) => `\`event.${f}\``).join(', ')}, which Inngest filled in. Pass ${extraEventFields.size === 1 ? 'it' : 'them'} in the event given to start(), or read the run ID and start time from getWorkflowMetadata().`,
      });
    }
  }

  function insideOwnThis(node: TS.Node, closure: TS.Node): boolean {
    // `this` inside a nested non-arrow function in the closure is its own.
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
  }

  function insideOwnArguments(node: TS.Node, closure: TS.Node): boolean {
    let current = node.parent;
    while (current && current !== closure) {
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isMethodDeclaration(current)
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  function isInside(node: TS.Node, container: TS.Node): boolean {
    return node.pos >= container.pos && node.end <= container.end;
  }

  function migrateWaitForEvent(
    call: TS.CallExpression,
    info: HandlerInfo,
    fn: MigratedFunction
  ): void {
    const notes = fn.notes;
    const opts = call.arguments[1];
    if (!opts || !ts.isObjectLiteralExpression(opts)) {
      addTodo(
        call,
        '`step.waitForEvent()` options are not an object literal. Replace it with createHook({ token }) raced against sleep(timeout).',
        notes
      );
      return;
    }
    const eventProp = getProperty(ts, opts, 'event');
    const timeout = getProperty(ts, opts, 'timeout');
    const match = getProperty(ts, opts, 'match');
    const ifExpr = getProperty(ts, opts, 'if');
    const eventName =
      eventProp && (literalText(ts, eventProp) ?? eventTypeNameOf(eventProp));
    if (!eventName) {
      addTodo(
        call,
        '`step.waitForEvent()` waits for an event whose name is not a string literal. Replace it with createHook({ token }) raced against sleep(timeout).',
        notes
      );
      return;
    }
    // The waited-for event is identified by one field. The run knows the
    // value it expects when it creates the hook, so the value becomes part of
    // the token, and the sender builds the same token from the event it sends.
    //   match: 'data.orderId'                        (same path on both sides)
    //   if: 'async.data.orderId == event.data.id'    (paths differ)
    //   if: `async.data.uuid == "${uuid}"`           (a value in the workflow)
    const PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
    const eventRef = eventReference(info);
    let senderPath: string | undefined;
    let waitValue: (() => string) | undefined;
    const keptForToken: TS.Node[] = [];
    if (match && !ifExpr) {
      const path = literalText(ts, match);
      if (path && PATH.test(path) && eventRef) {
        senderPath = path;
        waitValue = () => `${eventRef}.${path}`;
      }
    } else if (ifExpr) {
      const cel = skipParens(ts, ifExpr);
      const literal = literalText(ts, cel);
      const sameEvent = literal
        ? /^\s*async\.([\w$.]+)\s*==\s*event\.([\w$.]+)\s*$/.exec(literal)
        : null;
      if (
        sameEvent &&
        PATH.test(sameEvent[1]) &&
        PATH.test(sameEvent[2]) &&
        eventRef
      ) {
        senderPath = sameEvent[1];
        const right = sameEvent[2];
        waitValue = () => `${eventRef}.${right}`;
      } else if (
        ts.isTemplateExpression(cel) &&
        cel.templateSpans.length === 1
      ) {
        const head = /^\s*async\.([\w$.]+)\s*==\s*(["'])$/.exec(cel.head.text);
        const span = cel.templateSpans[0];
        if (
          head &&
          PATH.test(head[1]) &&
          span.literal.text.trim() === head[2]
        ) {
          senderPath = head[1];
          keptForToken.push(span.expression);
          waitValue = () => renderNode(span.expression);
        }
      }
    }
    if (!waitValue || !senderPath) {
      addTodo(
        call,
        ifExpr
          ? `\`step.waitForEvent()\` filters "${eventName}" with an \`if\` expression the codemod cannot translate. Pick a token that identifies the run (for example \`${eventName}:\${orderId}\`), create it with createHook({ token }), and call resumeHook(token, event) where "${eventName}" is sent.`
          : match
            ? !eventRef
              ? '`step.waitForEvent()` matches on the triggering event, but the handler does not read `event`. Add `event` to the handler parameters and run the codemod again.'
              : '`step.waitForEvent()` `match` is not a plain property path.'
            : `\`step.waitForEvent()\` waits for any "${eventName}" event. A hook needs a token that identifies this run: pick one, create it with createHook({ token }), and call resumeHook(token, event) where "${eventName}" is sent.`,
        notes
      );
      return;
    }
    // The workflow name is part of the token, so two workflows waiting for
    // the same event do not compete for one token; the sender resumes each.
    const tokenValue = waitValue;
    const prefix = escapeTemplate(`${eventName}:${fn.workflowName}`);
    const tokenText = () => `\`${prefix}:\${${tokenValue()}}\``;
    const resumeToken = `\`${prefix}:\${event.${senderPath}}\``;
    let typeArg = '';
    if (typed) {
      const typeText = printType(
        nonNullType(awaitedType(checker.getTypeAtLocation(call))),
        call
      );
      if (typeText) typeArg = `<${TYPE_START}${typeText}${TYPE_END}>`;
    }
    const createHook = wf('createHook');
    const wait = waitHelper();
    const sleep = timeout ? wf('sleep') : '';
    const tokenInfo: MigratedHook = {
      line: line(call),
      source: 'step.waitForEvent',
      name: eventName,
      token: tokenText(),
      resumeToken,
    };
    fn.hooks.push(tokenInfo);
    replaceCall(
      call,
      () =>
        `${wait}(${createHook}${typeArg}({ token: ${tokenText()} })${timeout ? `, ${sleep}(${renderNode(timeout)})` : ''})`,
      timeout ? [timeout, ...keptForToken] : keptForToken
    );
    // Inngest resumed every run waiting for the event; a token has one owner.
    addTodo(
      call,
      `Only one run at a time can own this hook token. Inngest resumed every run waiting for a matching "${eventName}"; if two ${fn.workflowName} runs can wait for the same key at once, add something unique to the token (for example the run ID) and resume each run where the event is sent. Otherwise, delete this comment.`,
      notes
    );
    notes.push({
      severity: 'info',
      line: line(call),
      message: `Resume this hook where "${eventName}" is sent: replace inngest.send(event) with resumeHook(${resumeToken}, event) from workflow/api.`,
    });
  }

  /**
   * One helper per file for the migrated waits: race the hook against the
   * timeout, and dispose it either way, so a later wait in the same run can
   * create a hook with the same token (Inngest allows waiting again).
   */
  function waitHelper(): string {
    if (waitHelperName) return waitHelperName;
    const name = names.allocate('waitForHook', 'OrTimeout');
    waitHelperName = name;
    const hookType = typed ? typeImport('Hook') : '';
    helpers.push(() => {
      const t = (text: string) => (typed ? text : '');
      const I = indentUnit;
      // With `onConflict: 'replace'`, Inngest left the replaced wait pending
      // until its timeout, which then returned null; a taken-over hook
      // rejects instead, so wait out the timeout here.
      const takenOver = forceClaimedError
        ? `${I}} catch (error) {\n` +
          `${I}${I}if (!timeout || !${forceClaimedError}.is(error)) throw error${semi}\n` +
          `${I}${I}await timeout${semi}\n` +
          `${I}${I}return null${semi}\n`
        : '';
      return (
        `/** Resolves with the hook's payload, or with null once \`timeout\` resolves. */\n` +
        `async function ${name}${t('<T>')}(hook${t(`: ${hookType}<T>`)}, timeout?${t(': Promise<void>')})${t(': Promise<T | null>')} {\n` +
        `${I}try {\n` +
        `${I}${I}return await (timeout ? Promise.race([hook, timeout.then(() => null)]) : hook)${semi}\n` +
        takenOver +
        `${I}} finally {\n` +
        `${I}${I}hook.dispose()${semi}\n` +
        `${I}}\n` +
        '}'
      );
    });
    return name;
  }

  function migrateWaitForSignal(
    call: TS.CallExpression,
    fn: MigratedFunction
  ): void {
    const notes = fn.notes;
    const opts = call.arguments[1];
    if (!opts || !ts.isObjectLiteralExpression(opts)) {
      addTodo(
        call,
        '`step.waitForSignal()` options are not an object literal.',
        notes
      );
      return;
    }
    const signal = getProperty(ts, opts, 'signal');
    const timeout = getProperty(ts, opts, 'timeout');
    const onConflict = getProperty(ts, opts, 'onConflict');
    if (!signal) {
      addTodo(call, '`step.waitForSignal()` has no `signal`.', notes);
      return;
    }
    const conflict = onConflict && literalText(ts, onConflict);
    if (onConflict && conflict !== 'replace' && conflict !== 'fail') {
      addTodo(
        call,
        '`step.waitForSignal()` `onConflict` is not a literal.',
        notes
      );
      return;
    }
    const force = conflict === 'replace' ? ', experimental_force: true' : '';
    if (force) {
      forceClaimedError = use('workflow/errors', 'HookForceClaimedError');
    }
    let typeArg = '';
    if (typed) {
      const typeText = printType(
        nonNullType(awaitedType(checker.getTypeAtLocation(call))),
        call
      );
      if (typeText) typeArg = `<${TYPE_START}${typeText}${TYPE_END}>`;
    }
    const createHook = wf('createHook');
    const wait = waitHelper();
    const sleep = timeout ? wf('sleep') : '';
    const signalText = signal.getText(sf);
    fn.hooks.push({
      line: line(call),
      source: 'step.waitForSignal',
      name: literalText(ts, signal) ?? signalText,
      token: signalText,
    });
    replaceCall(
      call,
      () =>
        `${wait}(${createHook}${typeArg}({ token: ${renderNode(signal)}${force} })${timeout ? `, ${sleep}(${renderNode(timeout)})` : ''})`,
      timeout ? [signal, timeout] : [signal]
    );
    notes.push({
      severity: 'info',
      line: line(call),
      message:
        'Resume this hook where the signal was sent: replace inngest.sendSignal({ signal, data }) with resumeHook(signal, { signal, data }) from workflow/api, so the payload keeps the shape step.waitForSignal() returned.',
    });
  }

  function migrateInvoke(call: TS.CallExpression, fn: MigratedFunction): void {
    const notes = fn.notes;
    const opts = call.arguments[1];
    if (!opts || !ts.isObjectLiteralExpression(opts)) {
      addTodo(
        call,
        '`step.invoke()` options are not an object literal. Replace it with start(childWorkflow, [event]) and await run.returnValue.',
        notes
      );
      return;
    }
    const target = getProperty(ts, opts, 'function');
    if (!target || !ts.isIdentifier(skipParens(ts, target))) {
      addTodo(
        call,
        '`step.invoke()` targets a function by reference (referenceFunction) or expression. Import the migrated workflow and call start(childWorkflow, [event]), then await run.returnValue.',
        notes
      );
      return;
    }
    const data = getProperty(ts, opts, 'data');
    const timeout = getProperty(ts, opts, 'timeout');
    const extra = opts.properties
      .map((p) => p.name && propertyNameText(ts, p.name))
      .filter(
        (k): k is string => !!k && !['function', 'data', 'timeout'].includes(k)
      );
    if (extra.length) {
      notes.push({
        severity: 'info',
        line: line(call),
        message: `\`step.invoke()\` options ${extra.map((k) => `\`${k}\``).join(', ')} were dropped.`,
      });
    }
    const start = use('workflow/api', 'start');
    const sleep = timeout ? wf('sleep') : '';
    const kept = [
      target,
      ...(data ? [data] : []),
      ...(timeout ? [timeout] : []),
    ];
    replaceCall(
      call,
      () => {
        const event = data ? `{ data: ${renderNode(data)} }` : '{ data: {} }';
        const run = `${start}(${renderNode(target)}, [${event}]).then((run) => run.returnValue)`;
        if (!timeout) return run;
        return `Promise.race([${run}, ${sleep}(${renderNode(timeout)}).then(() => { throw new Error('step.invoke() timed out') })])`;
      },
      kept
    );
    notes.push({
      severity: 'info',
      line: line(call),
      message: `\`step.invoke()\` now starts \`${target.getText(sf)}\` as a child run and waits for its return value. It must be a workflow function (migrated by this codemod or written by hand).`,
    });
  }

  /** Expression that reads the triggering event in the workflow body. */
  function eventReference(info: HandlerInfo): string | undefined {
    if (!info.eventParam) return undefined;
    if (/^[A-Za-z_$][\w$]*$/.test(info.eventParam)) return info.eventParam;
    return undefined;
  }

  function applyContextReplacements(
    handler: FunctionLike,
    info: HandlerInfo,
    fn: MigratedFunction,
    stepBodyRanges: Array<[number, number]>
  ): void {
    const insideLiftedStep = (node: TS.Node) => {
      const start = node.getStart(sf);
      return stepBodyRanges.some(([s, e]) => start >= s && node.end <= e);
    };
    const visit = (node: TS.Node): void => {
      if (
        ts.isIdentifier(node) &&
        !isNonReferenceName(ts, node) &&
        !ts.isBindingElement(node.parent)
      ) {
        let symbol: TS.Symbol | undefined;
        const shorthand =
          ts.isShorthandPropertyAssignment(node.parent) &&
          node.parent.name === node;
        symbol = shorthand
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : symbolOf(node);
        const replacement = symbol && info.replacements.get(symbol);
        if (replacement) {
          if (replacement.stepOnly && !insideLiftedStep(node)) {
            addTodo(
              node,
              '`attempt` is only available inside a step now: read getStepMetadata().attempt there (it counts from 1; Inngest counted from 0).',
              fn.notes
            );
          } else {
            let replacementText = replacement.text();
            // `(a - 1)` needs its parentheses only where the context binds
            // tighter than subtraction.
            if (replacementText.startsWith('(') && !needsParens(ts, node)) {
              replacementText = replacementText.slice(1, -1);
            }
            const start = node.getStart(sf);
            droppedRanges.push([start, node.end]);
            report.changed = true;
            edits.add(
              start,
              node.end,
              shorthand ? `${node.text}: ${replacementText}` : replacementText
            );
          }
        }
        if (symbol && info.unsupported.has(symbol)) {
          addTodo(node, info.unsupported.get(symbol) ?? '', fn.notes);
        }
      }
      // ctx.event / ctx.runId / ctx.logger in the ctx form.
      if (
        info.ctxSymbol &&
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        symbolOf(node.expression) === info.ctxSymbol
      ) {
        const key = node.name.text;
        const start = node.getStart(sf);
        if (key === 'event' && info.eventParam) {
          edits.add(start, node.end, info.eventParam);
          droppedRanges.push([start, node.end]);
          return;
        }
        if (key === 'runId') {
          edits.add(
            start,
            node.end,
            `${wf('getWorkflowMetadata')}().workflowRunId`
          );
          droppedRanges.push([start, node.end]);
          return;
        }
        if (key === 'logger') {
          edits.add(start, node.end, 'console');
          droppedRanges.push([start, node.end]);
          return;
        }
        if (key !== 'step') {
          addTodo(
            node,
            `\`${node.getText(sf)}\` came from the Inngest handler context and has no direct equivalent.`,
            fn.notes
          );
        }
        return;
      }
      if (
        info.ctxSymbol &&
        ts.isIdentifier(node) &&
        !isNonReferenceName(ts, node) &&
        !ts.isParameter(node.parent) &&
        symbolOf(node) === info.ctxSymbol &&
        !ts.isPropertyAccessExpression(node.parent)
      ) {
        addTodo(
          node,
          'The Inngest context object is used as a value; only `ctx.event`, `ctx.runId` and `ctx.logger` can be migrated.',
          fn.notes
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(handler.body);
  }

  function eventAnnotation(info: HandlerInfo): string | undefined {
    if (!info.eventTypeNode) return undefined;
    const type = checker.getTypeAtLocation(info.eventTypeNode);
    if (type.flags & ts.TypeFlags.Any) return 'any';
    // When the body only reads `event.data`, type just that: callers then
    // pass `{ data }` to start() without the fields Inngest filled in.
    if (info.eventSymbol && onlyReadsData(info.eventSymbol, info.handler)) {
      const data = type.getProperty('data');
      if (data) {
        const dataType = checker.getTypeOfSymbolAtLocation(
          data,
          info.eventTypeNode
        );
        // Untyped events (Inngest v3 without schemas) have `data: any`.
        const nonNull = checker.getNonNullableType(dataType);
        if (nonNull.flags & ts.TypeFlags.Any) return '{ data: any }';
        const printed = printType(nonNull, info.eventTypeNode);
        if (printed) return `{ data: ${printed} }`;
      }
    }
    return printType(type, info.eventTypeNode);
  }

  function onlyReadsData(symbol: TS.Symbol, scope: TS.Node): boolean {
    let ok = true;
    const visit = (node: TS.Node): void => {
      if (!ok) return;
      if (
        ts.isIdentifier(node) &&
        !ts.isBindingElement(node.parent) &&
        symbolOf(node) === symbol
      ) {
        const parent = node.parent;
        if (
          !(
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === node &&
            parent.name.text === 'data'
          )
        ) {
          ok = false;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit((scope as FunctionLike).body);
    return ok;
  }

  function awaitedType(type: TS.Type): TS.Type {
    const getAwaited = (
      checker as { getAwaitedType?: (t: TS.Type) => TS.Type | undefined }
    ).getAwaitedType;
    return getAwaited?.call(checker, type) ?? type;
  }

  function nonNullType(type: TS.Type): TS.Type {
    return checker.getNonNullableType(type);
  }

  function printType(type: TS.Type, at: TS.Node): string | undefined {
    if (type.flags & ts.TypeFlags.Any) return undefined;
    const printed = checker.typeToString(
      type,
      at,
      ts.TypeFormatFlags.NoTruncation |
        ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
    );
    if (
      !printed ||
      printed.length > 600 ||
      printed.includes('...') ||
      printed === 'any'
    ) {
      return undefined;
    }
    return tidyType(printed);
  }

  function statementShape(call: TS.CallExpression):
    | {
        statement: TS.Statement;
        name?: string;
        exported: boolean;
        isDefault: boolean;
      }
    | undefined {
    let expr: TS.Node = call;
    while (
      expr.parent &&
      (ts.isParenthesizedExpression(expr.parent) ||
        ts.isAsExpression(expr.parent) ||
        ts.isSatisfiesExpression?.(expr.parent))
    ) {
      expr = expr.parent;
    }
    const parent = expr.parent;
    if (
      parent &&
      ts.isVariableDeclaration(parent) &&
      parent.initializer === expr &&
      ts.isIdentifier(parent.name)
    ) {
      const list = parent.parent;
      const statement = list?.parent;
      if (
        ts.isVariableDeclarationList(list) &&
        list.declarations.length === 1 &&
        statement &&
        ts.isVariableStatement(statement)
      ) {
        const exported = !!statement.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword
        );
        return {
          statement,
          name: parent.name.text,
          exported,
          isDefault: false,
        };
      }
      return undefined;
    }
    if (parent && ts.isExportAssignment(parent) && !parent.isExportEquals) {
      return { statement: parent, exported: true, isDefault: true };
    }
    return undefined;
  }

  function readTriggers(node: TS.Expression): FunctionTrigger[] {
    const out: FunctionTrigger[] = [];
    const one = (expr: TS.Expression) => {
      const eventTypeName = eventTypeNameOf(expr);
      if (eventTypeName) {
        out.push({ kind: 'event', value: eventTypeName });
        return;
      }
      if (ts.isObjectLiteralExpression(expr)) {
        const event = getProperty(ts, expr, 'event');
        const cron = getProperty(ts, expr, 'cron');
        if (event)
          out.push({
            kind: 'event',
            value: literalText(ts, event) ?? event.getText(sf),
          });
        else if (cron)
          out.push({
            kind: 'cron',
            value: literalText(ts, cron) ?? cron.getText(sf),
          });
        else out.push({ kind: 'unknown', value: singleLine(expr.getText(sf)) });
        return;
      }
      out.push({ kind: 'unknown', value: singleLine(expr.getText(sf)) });
    };
    if (ts.isArrayLiteralExpression(node)) node.elements.forEach(one);
    else one(node);
    return out;
  }

  /**
   * Follow an identifier to the initializer of the `const` in this file that
   * declares it (through `as const` and parentheses), so config written as
   * `retries: MAX_RETRIES` or `createFunction(config, ...)` is still read.
   */
  function resolveConst(expr: TS.Expression, depth = 0): TS.Expression {
    let node = skipParens(ts, expr);
    while (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression?.(node) ||
      ts.isTypeAssertionExpression(node)
    ) {
      node = skipParens(ts, node.expression);
    }
    if (!ts.isIdentifier(node) || depth > 5) return node;
    const symbol = symbolOf(node);
    const declaration = symbol && firstDeclaration(symbol);
    if (
      declaration &&
      declaration.getSourceFile() === sf &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
    ) {
      return resolveConst(declaration.initializer, depth + 1);
    }
    return node;
  }

  /** `eventType('name', ...)`, directly or through a const in this file. */
  function eventTypeNameOf(expr: TS.Expression): string | undefined {
    let node = skipParens(ts, expr);
    if (ts.isIdentifier(node)) {
      const symbol = symbolOf(node);
      const declaration = symbol && firstDeclaration(symbol);
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer
      ) {
        node = skipParens(ts, declaration.initializer);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'eventType' &&
      node.arguments[0]
    ) {
      return literalText(ts, node.arguments[0]);
    }
    return undefined;
  }

  // --- Error classes ------------------------------------------------------

  if (errorRenames.size) {
    const visit = (node: TS.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const symbol = symbolOf(node.expression);
        const target = symbol && errorRenames.get(symbol);
        if (
          target === 'RetryableError' &&
          node.arguments &&
          node.arguments.length >= 2
        ) {
          // new RetryAfterError(message, retryAfter, { cause }) ->
          // new RetryableError(message, { retryAfter })
          const [message, retryAfter] = node.arguments;
          const start = node.getStart(sf);
          droppedRanges.push([start, node.end]);
          keptRanges.push(
            [message.getStart(sf), message.end],
            [retryAfter.getStart(sf), retryAfter.end]
          );
          const retryable = wf('RetryableError');
          edits.add(
            start,
            node.end,
            () =>
              `new ${retryable}(${renderNode(message)}, { retryAfter: ${renderNode(retryAfter)} })`
          );
          report.changed = true;
          node.arguments.forEach(visit);
          return;
        }
        if (
          target === 'FatalError' &&
          node.arguments &&
          node.arguments.length >= 2
        ) {
          // FatalError takes only a message.
          const [message] = node.arguments;
          const start = node.getStart(sf);
          droppedRanges.push([start, node.end]);
          keptRanges.push([message.getStart(sf), message.end]);
          const fatal = wf('FatalError');
          edits.add(
            start,
            node.end,
            () => `new ${fatal}(${renderNode(message)})`
          );
          report.changed = true;
          visit(message);
          return;
        }
      }
      if (
        ts.isIdentifier(node) &&
        !isNonReferenceName(ts, node) &&
        !ts.isImportSpecifier(node.parent)
      ) {
        const symbol = symbolOf(node);
        const target = symbol && errorRenames.get(symbol);
        if (target) {
          const start = node.getStart(sf);
          droppedRanges.push([start, node.end]);
          edits.add(start, node.end, wf(target));
          report.changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement)) visit(statement);
    }
  }

  // --- App boundary: inngest.send(), serve() ------------------------------

  const boundaryVisit = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        clientNames.has(callee.expression.text)
      ) {
        const method = callee.name.text;
        if (method === 'send' || method === 'sendSignal') {
          report.boundary.push({
            line: line(node),
            kind: method === 'send' ? 'send' : 'sendSignal',
            names:
              method === 'send'
                ? eventNamesOf(node.arguments[0])
                : signalOf(node.arguments[0]),
            text: singleLine(node.getText(sf)),
          });
        }
      }
      if (ts.isIdentifier(callee) && callee.text === 'serve') {
        const symbol = symbolOf(callee);
        const declaration = symbol && firstDeclaration(symbol);
        const importDecl =
          declaration && findAncestor(ts, declaration, ts.isImportDeclaration);
        if (
          importDecl &&
          ts.isStringLiteral(importDecl.moduleSpecifier) &&
          importDecl.moduleSpecifier.text.startsWith('inngest')
        ) {
          report.boundary.push({
            line: line(node),
            kind: 'serve',
            names: [],
            text: singleLine(node.getText(sf)),
          });
        }
      }
    }
    ts.forEachChild(node, boundaryVisit);
  };
  boundaryVisit(sf);

  function eventNamesOf(arg: TS.Expression | undefined): string[] {
    if (!arg) return [];
    const items = ts.isArrayLiteralExpression(arg) ? [...arg.elements] : [arg];
    const out: string[] = [];
    for (const item of items) {
      if (ts.isObjectLiteralExpression(item)) {
        const name = getProperty(ts, item, 'name');
        const value = name && literalText(ts, name);
        if (value) out.push(value);
      }
    }
    return out;
  }

  function signalOf(arg: TS.Expression | undefined): string[] {
    if (!arg || !ts.isObjectLiteralExpression(arg)) return [];
    const signal = getProperty(ts, arg, 'signal');
    return signal ? [literalText(ts, signal) ?? signal.getText(sf)] : [];
  }

  // --- TODO comments ------------------------------------------------------

  // Re-indentation first, so TODO comments use the line's new indentation.
  const protectedLine = (pos: number) =>
    templateRanges.some(([s, e]) => pos > s && pos < e);
  const regionFor = (pos: number): Region | undefined => {
    let best: Region | undefined;
    for (const region of regions) {
      if (pos > region.start && pos <= region.end) {
        if (!best || region.end - region.start < best.end - best.start)
          best = region;
      }
    }
    return best;
  };
  const mapIndent = (ws: string, region: Region) =>
    ws.startsWith(region.from)
      ? region.to + ws.slice(region.from.length)
      : region.to;
  const reindented = new Set<number>();
  for (const region of regions) {
    let pos = text.indexOf('\n', region.start);
    while (pos !== -1 && pos < region.end) {
      const lineStart = pos + 1;
      pos = text.indexOf('\n', lineStart);
      if (
        lineStart >= region.end ||
        reindented.has(lineStart) ||
        protectedLine(lineStart)
      )
        continue;
      const target = regionFor(lineStart);
      if (!target) continue;
      reindented.add(lineStart);
      const ws = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
      const rest = text.slice(lineStart + ws.length, lineStart + ws.length + 1);
      const blank = rest === '\n' || rest === '\r' || rest === '';
      edits.add(
        lineStart,
        lineStart + ws.length,
        blank ? '' : mapIndent(ws, target)
      );
    }
  }

  for (const [pos, messages] of todoStatements) {
    const lineStart = lineStartOf(text, pos);
    const ws = text.slice(lineStart, pos);
    const region = regionFor(lineStart);
    const indent =
      region && !protectedLine(lineStart) ? mapIndent(ws, region) : ws;
    report.changed = true;
    edits.insert(
      pos,
      messages.map((m) => `// ${TODO_TAG}: ${m}\n${indent}`).join('')
    );
  }

  // --- Imports ------------------------------------------------------------

  if (helpers.length) {
    const tail = text.endsWith('\n') ? '' : '\n';
    edits.insert(
      text.length,
      () => `${tail}\n${helpers.map((h) => h()).join('\n\n')}\n`
    );
  }

  const isDropped = (pos: number, end: number): boolean => {
    let innermost: { kind: 'drop' | 'keep'; size: number } | undefined;
    for (const [s, e] of droppedRanges) {
      if (pos >= s && end <= e && (!innermost || e - s <= innermost.size))
        innermost = { kind: 'drop', size: e - s };
    }
    for (const [s, e] of keptRanges) {
      if (pos >= s && end <= e && (!innermost || e - s < innermost.size))
        innermost = { kind: 'keep', size: e - s };
    }
    return innermost?.kind === 'drop';
  };

  /** References to `symbol`, and how many survive the edits. */
  const references = (
    symbol: TS.Symbol,
    declaration: TS.Node
  ): { total: number; live: number } => {
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
            ? checker.getShorthandAssignmentValueSymbol(node.parent)
            : symbolOf(node);
        if (s === symbol) {
          count.total++;
          if (!isDropped(node.getStart(sf), node.end)) count.live++;
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement)) visit(statement);
    }
    return count;
  };

  if (report.functions.length) {
    // A module-level `const` holding a plain literal (`const NO_RETRIES = 0`)
    // that only function options used goes with them. Anything else stays:
    // its initializer could have side effects, or other code could want it.
    for (const statement of sf.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        statement.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword
        ) ||
        !(statement.declarationList.flags & ts.NodeFlags.Const) ||
        statement.declarationList.declarations.length !== 1
      ) {
        continue;
      }
      const declaration = statement.declarationList.declarations[0];
      const init =
        declaration.initializer && skipParens(ts, declaration.initializer);
      const literal =
        !!init &&
        (ts.isNumericLiteral(init) ||
          ts.isStringLiteral(init) ||
          ts.isNoSubstitutionTemplateLiteral(init) ||
          init.kind === ts.SyntaxKind.TrueKeyword ||
          init.kind === ts.SyntaxKind.FalseKeyword);
      if (!literal || !ts.isIdentifier(declaration.name)) continue;
      const symbol = symbolOf(declaration.name);
      if (!symbol) continue;
      const { total, live } = references(symbol, declaration.name);
      if (total > 0 && live === 0) {
        const start = statement.getStart(sf);
        let end = statement.end;
        if (text[end] === '\n') end++;
        if (text[end] === '\n') end++;
        edits.add(start, end, '');
      }
    }
  }

  const removedImports = new Set<TS.ImportDeclaration>();
  if (report.functions.length || report.changed) {
    // Drop import specifiers whose every use was in code the codemod
    // removed: the Inngest client, the error classes, global `step`, and
    // anything used only by function config or triggers. Imports that were
    // already unused are not the codemod's business.
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause)
        continue;
      const clause = statement.importClause;
      const named =
        clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings
          : undefined;
      if (!named) continue;
      const removable = named.elements.filter((element) => {
        const symbol = symbolOf(element.name);
        if (!symbol) return false;
        const { total, live } = references(symbol, element.name);
        return total > 0 && live === 0;
      });
      if (!removable.length) continue;
      const remaining = named.elements.filter((e) => !removable.includes(e));
      report.changed = true;
      if (remaining.length === 0 && !clause.name) {
        removedImports.add(statement);
        const start = statement.getStart(sf);
        let end = statement.end;
        if (text[end] === '\n') end++;
        else if (text.slice(end, end + 2) === '\r\n') end += 2;
        edits.add(start, end, '');
      } else {
        edits.add(
          named.getStart(sf),
          named.end,
          `{ ${remaining.map((e) => e.getText(sf)).join(', ')} }`
        );
      }
    }
  }

  if (workflowImports.size || apiImports.size || errorsImports.size) {
    report.changed = true;
    const lines: string[] = [];
    const existing = (module: string) =>
      sf.statements.find(
        (s): s is TS.ImportDeclaration =>
          ts.isImportDeclaration(s) &&
          ts.isStringLiteral(s.moduleSpecifier) &&
          s.moduleSpecifier.text === module &&
          !!s.importClause?.namedBindings &&
          ts.isNamedImports(s.importClause.namedBindings) &&
          !s.importClause.isTypeOnly
      );
    const addImport = (module: string, wanted: Set<string>) => {
      if (!wanted.size) return;
      const current = existing(module);
      if (current) {
        const named = current.importClause?.namedBindings as TS.NamedImports;
        const have = new Set(named.elements.map((e) => e.getText(sf)));
        const merged = [
          ...have,
          ...[...wanted].filter((w) => !have.has(w)),
        ].sort(sortImports);
        edits.add(named.getStart(sf), named.end, `{ ${merged.join(', ')} }`);
        return;
      }
      lines.push(
        `import { ${[...wanted].sort(sortImports).join(', ')} } from ${quote}${module}${quote}${semi}`
      );
    };
    addImport('workflow', workflowImports);
    addImport('workflow/api', apiImports);
    addImport('workflow/errors', errorsImports);
    if (lines.length) {
      const imports = sf.statements.filter(ts.isImportDeclaration);
      const kept = imports.filter((i) => !removedImports.has(i));
      const anchor = kept[kept.length - 1];
      if (anchor) {
        edits.insert(anchor.end, `\n${lines.join('\n')}`);
      } else if (imports.length) {
        // Every import is removed: put the new ones where the first was.
        edits.insert(imports[0].getStart(sf), `${lines.join('\n')}\n`);
      } else {
        const first = sf.statements[0];
        const pos = first ? first.getStart(sf) : 0;
        edits.insert(pos, `${lines.join('\n')}\n\n`);
      }
    }
  }

  if (report.functions.length) report.changed = true;
  const code = report.changed ? edits.apply() : text;
  return { code, report };
}

/** `{ a: string; }` -> `{ a: string }`, as formatters write object types. */
export function tidyType(printed: string): string {
  return printed.replace(/; \}/g, ' }');
}

function sortImports(a: string, b: string): number {
  const key = (s: string) => s.replace(/^type /, '').toLowerCase();
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
}

// --- Helpers --------------------------------------------------------------

export function isTypeScriptFile(fileName: string): boolean {
  return /\.(ts|tsx|mts|cts)$/.test(fileName) && !fileName.endsWith('.d.ts');
}

function isExpressionList(target: unknown): target is readonly TS.Expression[] {
  return Array.isArray(target);
}

function isFunctionLike(
  ts: typeof TS,
  node: TS.Node | undefined
): node is FunctionLike {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function skipParens(ts: typeof TS, node: TS.Expression): TS.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function hasModifier(
  ts: typeof TS,
  node: TS.Node,
  kind: TS.SyntaxKind
): boolean {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  return !!modifiers?.some((m) => m.kind === kind);
}

function enclosingFunction(ts: typeof TS, node: TS.Node): TS.Node | undefined {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current) || ts.isClassStaticBlockDeclaration(current))
      return current;
    current = current.parent;
  }
  return undefined;
}

function findAncestor<T extends TS.Node>(
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

function propertyNameText(
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

function getProperty(
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

function literalText(ts: typeof TS, node: TS.Expression): string | undefined {
  const expr = skipParens(ts, node);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
    return expr.text;
  return undefined;
}

function firstDeclaration(symbol: TS.Symbol): TS.Declaration | undefined {
  return symbol.valueDeclaration ?? symbol.declarations?.[0];
}

function rootIdentifier(
  ts: typeof TS,
  node: TS.Expression
): TS.Identifier | undefined {
  let current = node;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current : undefined;
}

function isSimpleReference(ts: typeof TS, node: TS.Expression): boolean {
  if (ts.isIdentifier(node)) return true;
  return (
    ts.isPropertyAccessExpression(node) &&
    isSimpleReference(ts, node.expression)
  );
}

function isTypeOnlyDeclaration(ts: typeof TS, node: TS.Node): boolean {
  return (
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeParameterDeclaration(node)
  );
}

function isFunctionOrClassDeclaration(ts: typeof TS, node: TS.Node): boolean {
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

function isInsideParameter(ts: typeof TS, node: TS.Node): boolean {
  let current: TS.Node | undefined = node;
  while (current && !ts.isFunctionLike(current)) {
    if (ts.isParameter(current)) return true;
    current = current.parent;
  }
  return false;
}

function inTypePosition(ts: typeof TS, node: TS.Node): boolean {
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
function needsParens(ts: typeof TS, node: TS.Node): boolean {
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
function isDeclarationName(ts: typeof TS, node: TS.Identifier): boolean {
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
function isNonReferenceName(ts: typeof TS, node: TS.Identifier): boolean {
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
function isAssignmentTarget(ts: typeof TS, node: TS.Node): boolean {
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
function isMutatedProperty(ts: typeof TS, node: TS.Node): boolean {
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

function singleLine(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max
    ? `${collapsed.slice(0, max - 3)}...`
    : collapsed;
}

function escapeTemplate(text: string): string {
  return text.replace(/[`\\]/g, '\\$&').replace(/\$\{/g, '\\${');
}

/** Normalize a rendered body: drop blank edges, indent a one-line body. */
function trimRendered(rendered: string, indent: string): string {
  const lines = rendered.split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) return '';
  if (!/^[ \t]/.test(lines[0])) lines[0] = indent + lines[0];
  else if (!lines[0].startsWith(indent))
    lines[0] = indent + lines[0].trimStart();
  return lines.map((l) => l.replace(/[ \t]+$/, '')).join('\n');
}

function detectQuote(sf: TS.SourceFile): string {
  const text = sf.text;
  const single =
    (text.match(/from '/g) ?? []).length + (text.match(/'use /g) ?? []).length;
  const double =
    (text.match(/from "/g) ?? []).length + (text.match(/"use /g) ?? []).length;
  return double > single ? '"' : "'";
}

function detectSemicolons(sf: TS.SourceFile): boolean {
  let withSemi = 0;
  let without = 0;
  for (const statement of sf.statements.slice(0, 30)) {
    const t = statement.getText(sf);
    if (t.endsWith(';')) withSemi++;
    else if (!t.endsWith('}')) without++;
  }
  return withSemi >= without;
}
