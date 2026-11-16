import type * as TS from 'typescript';
import {
  detectQuote,
  detectSemicolons,
  escapeTemplate,
  type FunctionLike,
  firstDeclaration,
  getProperty,
  isDeclarationName,
  isFunctionLike,
  isNonReferenceName,
  isSimpleReference,
  literalText,
  propertyNameText,
  rootIdentifier,
  singleLine,
  skipParens,
  sortImports,
  trimRendered,
} from '../ast.js';
import { analyzeCaptures } from '../captures.js';
import {
  detectIndentUnit,
  EditSet,
  indentAt,
  lineOf,
  lineStartOf,
} from '../edits.js';
import { INFER_MARK, isTypeScriptFile, TODO_TAG } from '../markers.js';
import { camelCaseIdentifier, NameAllocator } from '../names.js';
import type {
  FileReport,
  MigratedFunction,
  MigrationNote,
} from '../report-types.js';

/**
 * Cloudflare Workflows -> Workflow SDK codemod for one file.
 *
 * A `class X extends WorkflowEntrypoint` becomes a `"use workflow"` function
 * named `X` that takes the event, and each `step.do(name, callback)` becomes
 * a module-level `"use step"` function whose parameters are the variables
 * the callback read from `run()`. Semantics follow Cloudflare's engine:
 *
 * - `retries.limit` counts retries after the first attempt, like
 *   `maxRetries`, and defaults to 5 (the Workflow SDK defaults to 3), so
 *   every lifted step gets an explicit `maxRetries`.
 * - Durations are `"<n> <second|minute|hour|day|week|month|year>[s]"` or
 *   milliseconds; a month is 30 days and a year 365.25 days.
 * - Events sent to an instance are queued per type until a
 *   `step.waitForEvent()` for that type takes them, and a wait that times
 *   out throws. The migrated run reads its events from its start Hook
 *   (`start(..., { experimental_hook: { token } })` keeps payloads resumed
 *   before the run opens it), through a helper that consumes them per type.
 *
 * Anything that cannot be migrated without changing behavior stays in place
 * under a `TODO(workflow-migrate)` comment.
 */

export interface CloudflareContext {
  /** `vars` from the wrangler config: plain strings, readable from env. */
  vars: Set<string>;
  /** Binding name -> what it is, e.g. `KV namespace`. */
  bindings: Map<string, string>;
  /** `[[workflows]]` entries of the wrangler config. */
  workflows: Array<{ binding: string; className: string; name?: string }>;
  configFile?: string;
}

export interface CloudflareTransformOptions {
  ts: typeof TS;
  sourceFile: TS.SourceFile;
  checker: TS.TypeChecker;
  reportName: string;
  context: CloudflareContext;
}

/** Cloudflare's duration units, in milliseconds. */
export const DURATION_UNITS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_557_600_000,
};
const DURATION =
  /^\s*(\d+(?:\.\d+)?)\s+(second|minute|hour|day|week|month|year)s?\s*$/;
const DEFAULT_RETRY_LIMIT = 5;
const DEFAULT_WAIT_TIMEOUT_MS = 86_400_000; // 24 hours

interface Region {
  start: number;
  end: number;
  from: string;
  to: string;
}

const STEP_METHODS = new Set(['do', 'sleep', 'sleepUntil', 'waitForEvent']);

export function transformCloudflareWorkflowsFile(
  options: CloudflareTransformOptions
): { code: string; report: FileReport } {
  const { ts, sourceFile: sf, checker, context } = options;
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
  const line = (node: TS.Node | number) =>
    lineOf(text, typeof node === 'number' ? node : node.getStart(sf));
  const symbolOf = (node: TS.Node) => checker.getSymbolAtLocation(node);

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

  // --- Imports the migrated code needs, under collision-free names --------

  const imports: Record<'workflow' | 'workflow/api', Set<string>> = {
    workflow: new Set(),
    'workflow/api': new Set(),
  };
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
          const typeOnly =
            specifier.isTypeOnly || !!decl.importClause?.isTypeOnly;
          from = `${decl.moduleSpecifier.text}:${typeOnly ? 'type:' : ''}${(specifier.propertyName ?? specifier.name).text}`;
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
  const use = (
    module: 'workflow' | 'workflow/api',
    name: string,
    type = false
  ): string => {
    const key = `${module}:${type ? 'type:' : ''}${name}`;
    const known = aliases.get(key);
    if (known) return known;
    const reusable = (candidate: string) =>
      declaredNames.get(candidate) === `${module}:${name}` ||
      (type && declaredNames.get(candidate) === `${module}:type:${name}`);
    let local = name;
    if (declaredNames.has(local) && !reusable(local)) {
      const base = `workflow${name[0].toUpperCase()}${name.slice(1)}`;
      local = base;
      for (
        let n = 2;
        declaredNames.has(local) || allIdentifiers.has(local);
        n++
      ) {
        local = `${base}${n}`;
      }
    }
    names.reserve(local);
    aliases.set(key, local);
    if (!reusable(local)) {
      const spec = local === name ? name : `${name} as ${local}`;
      imports[module].add(type ? `type ${spec}` : spec);
    }
    return local;
  };
  const wf = (name: string) => use('workflow', name);

  /** Module-level helpers the generated code calls, appended to the file. */
  const helpers = new Map<string, () => string>();

  // Ranges whose original references are dropped from the output, and the
  // sub-ranges re-rendered inside them (to tell which imports stay used).
  const droppedRanges: Array<[number, number]> = [];
  const keptRanges: Array<[number, number]> = [];
  const regions: Region[] = [];
  const todoStatements = new Map<number, string[]>();
  /** Imports of `cloudflare:*` modules left in a migrated file. */
  const pendingCloudflareImports: TS.ImportDeclaration[] = [];

  const statementOf = (node: TS.Node): TS.Statement | undefined => {
    let current: TS.Node | undefined = node;
    while (current) {
      const parent: TS.Node | undefined = current.parent;
      if (
        parent &&
        (ts.isBlock(parent) ||
          ts.isSourceFile(parent) ||
          ts.isCaseClause(parent) ||
          ts.isDefaultClause(parent)) &&
        ts.isStatement(current)
      ) {
        return current;
      }
      current = parent;
    }
    return undefined;
  };
  const addTodo = (node: TS.Node, message: string, notes: MigrationNote[]) => {
    notes.push({ severity: 'todo', line: line(node), message });
    const statement = statementOf(node);
    if (!statement) return;
    const pos = statement.getStart(sf);
    const list = todoStatements.get(pos) ?? [];
    if (!list.includes(message)) list.push(message);
    todoStatements.set(pos, list);
  };
  const render = (node: TS.Node) => edits.render(node.getStart(sf), node.end);
  const replace = (
    node: TS.Node,
    renderText: () => string,
    kept: TS.Node[] = []
  ) => {
    const start = node.getStart(sf);
    droppedRanges.push([start, node.end]);
    for (const k of kept) keptRanges.push([k.getStart(sf), k.end]);
    report.changed = true;
    edits.add(start, node.end, renderText);
  };
  const inside = (node: TS.Node, container: TS.Node) =>
    node.pos >= container.pos && node.end <= container.end;

  // --- Imports from Cloudflare -------------------------------------------

  const entrypointSymbols = new Set<TS.Symbol>();
  const nonRetryableSymbols = new Set<TS.Symbol>();
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const module = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      const symbol = symbolOf(element.name);
      if (!symbol) continue;
      if (
        module === 'cloudflare:workers' &&
        imported === 'WorkflowEntrypoint'
      ) {
        entrypointSymbols.add(symbol);
      }
      if (
        module === 'cloudflare:workflows' &&
        imported === 'NonRetryableError'
      ) {
        nonRetryableSymbols.add(symbol);
      }
    }
  }

  const isEntrypointClass = (node: TS.ClassDeclaration): boolean =>
    !!node.heritageClauses?.some(
      (clause) =>
        clause.token === ts.SyntaxKind.ExtendsKeyword &&
        clause.types.some((t) => {
          const expr = t.expression;
          if (!ts.isIdentifier(expr)) return false;
          const symbol = symbolOf(expr);
          return (
            (symbol && entrypointSymbols.has(symbol)) ||
            expr.text === 'WorkflowEntrypoint'
          );
        })
    );

  for (const statement of sf.statements) {
    if (ts.isClassDeclaration(statement) && isEntrypointClass(statement)) {
      const fn = migrateClass(statement);
      if (fn) report.functions.push(fn);
    }
  }
  // Classes anywhere else (nested, or as expressions) are reported, not moved.
  const findNested = (node: TS.Node): void => {
    if (
      (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
      !(ts.isClassDeclaration(node) && ts.isSourceFile(node.parent)) &&
      node.heritageClauses?.some((c) =>
        c.types.some((t) => t.expression.getText(sf) === 'WorkflowEntrypoint')
      )
    ) {
      report.notes.push({
        severity: 'todo',
        line: line(node),
        message:
          'This WorkflowEntrypoint class is not a top-level class declaration, so it was not migrated. Move it to module scope and run the codemod again.',
      });
    }
    ts.forEachChild(node, findNested);
  };
  findNested(sf);

  function migrateClass(
    cls: TS.ClassDeclaration
  ): MigratedFunction | undefined {
    const className = cls.name?.text ?? 'Workflow';
    const notes: MigrationNote[] = [];
    const fn: MigratedFunction = {
      sourceId: className,
      workflowName: cls.name?.text ?? names.allocate('workflow', 'Workflow'),
      line: line(cls),
      triggers: [],
      steps: [],
      hooks: [],
      notes,
      config: {},
    };
    const runMethod = cls.members.find(
      (m): m is TS.MethodDeclaration =>
        ts.isMethodDeclaration(m) &&
        !!m.name &&
        propertyNameText(ts, m.name) === 'run' &&
        !!m.body
    );
    const others = cls.members.filter(
      (m) => m !== runMethod && !ts.isSemicolonClassElement(m)
    );
    if (!runMethod?.body) {
      report.notes.push({
        severity: 'todo',
        line: line(cls),
        message: `\`${className}\` has no \`run()\` method body, so it was not migrated.`,
      });
      return undefined;
    }
    if (others.length) {
      report.notes.push({
        severity: 'todo',
        line: line(cls),
        message: `\`${className}\` has members other than \`run()\` (${others.map((m) => (m.name ? m.name.getText(sf) : 'constructor')).join(', ')}), so it was not migrated. Move them to module-level functions and run the codemod again.`,
      });
      return undefined;
    }
    const run: TS.MethodDeclaration = runMethod;
    if (run.asteriskToken) {
      report.notes.push({
        severity: 'todo',
        line: line(run),
        message: 'Generator `run()` methods are not supported.',
      });
      return undefined;
    }
    const [eventParam, stepParam] = run.parameters;
    const stepSymbol =
      stepParam && ts.isIdentifier(stepParam.name)
        ? symbolOf(stepParam.name)
        : undefined;
    if (stepParam && !stepSymbol) {
      report.notes.push({
        severity: 'todo',
        line: line(stepParam),
        message:
          'The step tools are destructured in the `run()` signature; name the parameter (`step`) and run the codemod again.',
      });
      return undefined;
    }
    const eventName =
      eventParam && ts.isIdentifier(eventParam.name)
        ? eventParam.name.text
        : undefined;
    names.reserve(fn.workflowName);

    // The payload type: `WorkflowEvent<P>` on the parameter, or the second
    // type argument of `WorkflowEntrypoint<Env, P>`.
    let payloadType: TS.TypeNode | undefined;
    if (
      eventParam?.type &&
      ts.isTypeReferenceNode(eventParam.type) &&
      eventParam.type.typeArguments?.[0]
    ) {
      payloadType = eventParam.type.typeArguments[0];
    } else {
      const heritage = cls.heritageClauses?.find(
        (c) => c.token === ts.SyntaxKind.ExtendsKeyword
      )?.types[0];
      payloadType = heritage?.typeArguments?.[1];
    }
    if (payloadType)
      keptRanges.push([payloadType.getStart(sf), payloadType.end]);

    const body = runMethod.body;
    const bodyRange: [number, number] = [body.getStart(sf) + 1, body.end - 1];
    keptRanges.push(bodyRange);

    // --- `this.env.X` and other uses of the class ---
    const handled = new Set<TS.Node>();
    const stepBodies: Array<[number, number]> = [];
    const envPlan: Array<{ node: TS.PropertyAccessExpression; name: string }> =
      [];
    const visitThis = (node: TS.Node): void => {
      if (node.kind === ts.SyntaxKind.ThisKeyword && !ownThis(node, run)) {
        const parent = node.parent;
        if (
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node
        ) {
          const member = parent.name.text;
          const outer = parent.parent;
          if (
            member === 'env' &&
            ts.isPropertyAccessExpression(outer) &&
            outer.expression === parent
          ) {
            envPlan.push({ node: outer, name: outer.name.text });
            handled.add(outer);
            return;
          }
          handled.add(parent);
          addTodo(
            parent,
            member === 'ctx'
              ? '`this.ctx` is the Worker execution context, which does not exist in the Workflow SDK. `waitUntil()` work belongs in a step.'
              : `\`this.${member}\` is a member of the WorkflowEntrypoint class, which does not exist in the Workflow SDK.`,
            notes
          );
          return;
        }
        handled.add(node);
        addTodo(
          node,
          '`this` refers to the WorkflowEntrypoint class, which does not exist in the Workflow SDK.',
          notes
        );
        return;
      }
      ts.forEachChild(node, visitThis);
    };
    visitThis(body);

    // --- Step tool calls ---
    interface StepCall {
      call: TS.CallExpression;
      method: string;
    }
    const stepCalls: StepCall[] = [];
    const isStepRef = (node: TS.Node) =>
      !!stepSymbol && ts.isIdentifier(node) && symbolOf(node) === stepSymbol;
    const visitSteps = (node: TS.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        isStepRef(node.expression.expression)
      ) {
        stepCalls.push({ call: node, method: node.expression.name.text });
        node.arguments.forEach(visitSteps);
        return;
      }
      if (
        isStepRef(node) &&
        !(
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node
        )
      ) {
        addTodo(
          node,
          'The step tools are used here other than as a direct `step.*()` call (for example passed to a helper). Migrate the step calls in that code by hand: each `step.do()` becomes a "use step" function.',
          notes
        );
        return;
      }
      ts.forEachChild(node, visitSteps);
    };
    visitSteps(body);

    const nestedInner = new Set<TS.CallExpression>();
    const nestedOuter = new Set<TS.CallExpression>();
    for (const outer of stepCalls.filter((s) => s.method === 'do')) {
      for (const inner of stepCalls) {
        if (inner !== outer && inside(inner.call, outer.call)) {
          nestedInner.add(inner.call);
          nestedOuter.add(outer.call);
        }
      }
    }

    const lifted: Array<() => string> = [];
    let inbox: string | undefined;
    let eventsHelper: string | undefined;
    const needInbox = () => {
      if (inbox) return inbox;
      inbox = names.allocate('events', 'Inbox');
      eventsHelper = workflowEventsHelper();
      return inbox;
    };

    for (const stepCall of stepCalls) {
      const { call, method } = stepCall;
      if (nestedInner.has(call)) continue;
      if (nestedOuter.has(call)) {
        addTodo(
          call,
          'A step tool is called inside a `step.do()` callback. Move the inner call out to `run()`.',
          notes
        );
        continue;
      }
      if (!STEP_METHODS.has(method)) {
        addTodo(
          call,
          `\`step.${method}()\` has no Workflow SDK equivalent the codemod knows about.`,
          notes
        );
        continue;
      }
      if (method === 'do') liftStep(call);
      else if (method === 'sleep') migrateSleep(call);
      else if (method === 'sleepUntil') migrateSleepUntil(call);
      else migrateWait(call);
    }

    // --- env: vars become process.env inside steps; bindings are TODOs ---
    for (const { node, name } of envPlan) {
      const inStep = stepBodies.some(
        ([s, e]) => node.getStart(sf) >= s && node.end <= e
      );
      const kind = context.bindings.get(name);
      if (context.vars.has(name) && inStep) {
        replace(node, () => `process.env.${name}`);
        continue;
      }
      if (context.vars.has(name)) {
        addTodo(
          node,
          `\`this.env.${name}\` is a var. Workflow functions cannot read the environment: read \`process.env.${name}\` inside a "use step" function and pass the value in.`,
          notes
        );
        continue;
      }
      addTodo(
        node,
        kind
          ? `\`this.env.${name}\` is a ${kind} binding, which exists only on Cloudflare. Replace it with a client for a service reachable from Node (for example a database or key-value store from the Vercel Marketplace), used inside a "use step" function.`
          : `\`this.env.${name}\` is not declared in a wrangler config the codemod found. If it is a var, read \`process.env.${name}\` inside a step; if it is a binding, replace it with a client for a service reachable from Node.`,
        notes
      );
    }

    // `event.schedule` only exists on scheduled runs.
    if (eventName) {
      const visitEvent = (node: TS.Node): void => {
        if (
          ts.isPropertyAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === eventName &&
          node.name.text === 'schedule'
        ) {
          addTodo(
            node,
            '`event.schedule` is set when a cron schedule started the run. Start the workflow from a scheduled job (for example a Vercel Cron Job) and pass the schedule in the event instead.',
            notes
          );
        }
        ts.forEachChild(node, visitEvent);
      };
      visitEvent(body);
    }

    regions.push({
      start: bodyRange[0],
      end: bodyRange[1],
      from: contentIndent(body),
      to: indentUnit,
    });

    notes.sort((a, b) => a.line - b.line);

    // --- The statement ---
    const exported = !!cls.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword
    );
    const isDefault = !!cls.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.DefaultKeyword
    );
    const start = cls.getStart(sf);
    droppedRanges.push([start, cls.end]);
    report.changed = true;
    edits.add(start, cls.end, () => {
      let param = eventParam ? eventParam.name.getText(sf) : '';
      if (param && typed) {
        const payload = payloadType ? render(payloadType) : 'any';
        param += `: { payload: ${payload}; timestamp: Date; instanceId: string; workflowName: string }`;
      }
      const prefix = exported
        ? isDefault
          ? 'export default '
          : 'export '
        : '';
      const inboxLine = inbox
        ? `${indentUnit}const ${inbox} = ${eventsHelper}(\`${escapeTemplate(fn.workflowName)}:\${${eventName}.instanceId}\`)${semi}\n`
        : '';
      const rendered = trimRendered(
        edits.render(bodyRange[0], bodyRange[1]),
        indentUnit
      );
      const parts = [
        `${prefix}async function ${fn.workflowName}(${param}) {\n` +
          `${indentUnit}${quote}use workflow${quote}${semi}\n` +
          inboxLine +
          (rendered ? `${rendered}\n` : '') +
          '}',
        ...lifted.map((l) => l()),
      ];
      return parts.join('\n\n');
    });
    if (inbox && !eventName) {
      notes.push({
        severity: 'todo',
        line: line(run),
        message:
          'The workflow waits for events but `run()` does not name its event parameter, which the event inbox token needs. Name it (`event`) and run the codemod again.',
      });
    }
    return fn;

    function liftStep(call: TS.CallExpression): void {
      const args = call.arguments;
      const nameArg = args[0];
      let config: TS.Expression | undefined;
      let callback: TS.Expression | undefined;
      let rollback: TS.Expression | undefined;
      if (args.length >= 3 && !isFunctionLike(ts, skipParens(ts, args[1]))) {
        [, config, callback, rollback] = args;
      } else {
        [, callback, rollback] = args;
      }
      if (!nameArg || !callback) {
        addTodo(call, '`step.do()` without a name and a callback.', notes);
        return;
      }
      const stepName = literalText(ts, nameArg);
      const staticText = ts.isTemplateExpression(nameArg)
        ? [
            nameArg.head.text,
            ...nameArg.templateSpans.map((s) => s.literal.text),
          ].join(' ')
        : stepName;
      const base = camelCaseIdentifier(staticText ?? '') ?? 'step';
      const quotedName =
        stepName === undefined
          ? undefined
          : quote === '"'
            ? JSON.stringify(stepName)
            : `'${stepName.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

      // Retries: Cloudflare's limit counts retries, like maxRetries.
      let limit: number | undefined = DEFAULT_RETRY_LIMIT;
      const configObject = config ? resolveObject(config) : undefined;
      if (config && !configObject) {
        addTodo(
          call,
          `The step config \`${singleLine(config.getText(sf), 80)}\` is not an object literal the codemod can read. Set \`maxRetries\` on the step by hand (Cloudflare's default is 5 retries).`,
          notes
        );
        limit = undefined;
      }
      if (configObject) {
        const retries = getProperty(ts, configObject, 'retries');
        const retriesObject = retries ? resolveObject(retries) : undefined;
        if (retries && !retriesObject) {
          addTodo(
            call,
            '`retries` is not an object literal the codemod can read. Set `maxRetries` on the step by hand.',
            notes
          );
          limit = undefined;
        }
        if (retriesObject) {
          const limitNode = getProperty(ts, retriesObject, 'limit');
          const limitValue = limitNode && resolveLiteral(limitNode);
          if (limitValue && ts.isNumericLiteral(limitValue))
            limit = Number(limitValue.text);
          else {
            addTodo(
              call,
              '`retries.limit` is not a number the codemod can read. Set `maxRetries` on the step by hand.',
              notes
            );
            limit = undefined;
          }
          const delay = getProperty(ts, retriesObject, 'delay');
          const backoff = getProperty(ts, retriesObject, 'backoff');
          if (delay || backoff) {
            notes.push({
              severity: 'info',
              line: line(call),
              message: `The retry delay (${[delay && `delay: ${singleLine(delay.getText(sf), 40)}`, backoff && `backoff: ${singleLine(backoff.getText(sf), 30)}`].filter(Boolean).join(', ')}) is not carried over: Workflow SDK steps retry after about a second. Where the wait matters, catch the error in the step and throw \`new RetryableError(message, { retryAfter })\` with the delay you need.`,
            });
          }
        }
        const timeout = getProperty(ts, configObject, 'timeout');
        if (timeout) {
          addTodo(
            call,
            `Cloudflare stopped each attempt of this step after \`${singleLine(timeout.getText(sf), 40)}\`. The Workflow SDK has no per-step timeout: bound the work inside the step, for example with \`AbortSignal.timeout(ms)\` passed to \`fetch()\`.`,
            notes
          );
        }
        if (getProperty(ts, configObject, 'sensitive')) {
          notes.push({
            severity: 'info',
            line: line(call),
            message:
              '`sensitive: "output"` was dropped. Step outputs are encrypted on Vercel by default.',
          });
        }
      }
      if (rollback) {
        addTodo(
          call,
          '`step.do()` registers a rollback handler. The Workflow SDK has no rollback phase: keep a list of compensations in the workflow and run them in a `catch` block (see the rollback pattern in the migration guide).',
          notes
        );
      }

      const closure = skipParens(ts, callback);
      if (!isFunctionLike(ts, closure)) {
        const root = rootIdentifier(ts, closure);
        const rootSymbol = root && symbolOf(root);
        const declaration = rootSymbol
          ? firstDeclaration(rootSymbol)
          : undefined;
        const moduleLevel =
          !declaration ||
          declaration.getSourceFile() !== sf ||
          !inside(declaration, run);
        if (!root || !moduleLevel || !isSimpleReference(ts, closure)) {
          addTodo(
            call,
            '`step.do()` was given a callback the codemod cannot move to module scope. Wrap it in a "use step" function by hand.',
            notes
          );
          return;
        }
        const name = names.allocate(base);
        const refText = closure.getText(sf);
        keptRanges.push([closure.getStart(sf), closure.end]);
        lifted.push(() =>
          stepFunction(
            name,
            '',
            `${indentUnit}return ${refText}()${semi}`,
            '',
            limit
          )
        );
        replace(call, () => `${name}()`);
        fn.steps.push({
          stepId: stepName ?? nameArg.getText(sf),
          dynamicId: stepName === undefined,
          functionName: name,
          line: line(call),
          source: 'step.do',
          captured: [],
          inputs: 0,
        });
        return;
      }
      const callbackFn = closure as FunctionLike;
      if (callbackFn.asteriskToken) {
        addTodo(call, 'Generator step callbacks are not supported.', notes);
        return;
      }

      // The callback's `ctx`: `ctx.attempt` and `ctx.step.name` carry over.
      const ctxParam = callbackFn.parameters[0];
      const ctxSymbol =
        ctxParam && ts.isIdentifier(ctxParam.name)
          ? symbolOf(ctxParam.name)
          : undefined;
      if (ctxParam && !ctxSymbol) {
        addTodo(
          call,
          'The step callback destructures its context; use `ctx.attempt` and run the codemod again.',
          notes
        );
        return;
      }
      const ctxHandled = new Set<TS.Node>();
      if (ctxSymbol) {
        const visitCtx = (node: TS.Node): void => {
          if (
            ts.isIdentifier(node) &&
            node !== ctxParam?.name &&
            symbolOf(node) === ctxSymbol
          ) {
            const parent = node.parent;
            if (
              ts.isPropertyAccessExpression(parent) &&
              parent.expression === node &&
              parent.name.text === 'attempt'
            ) {
              ctxHandled.add(parent);
              const getStepMetadata = wf('getStepMetadata');
              replace(parent, () => `${getStepMetadata}().attempt`);
              return;
            }
            const grand = parent.parent;
            if (
              ts.isPropertyAccessExpression(parent) &&
              parent.name.text === 'step' &&
              grand &&
              ts.isPropertyAccessExpression(grand) &&
              grand.name.text === 'name' &&
              quotedName !== undefined
            ) {
              ctxHandled.add(grand);
              replace(grand, () => quotedName);
              return;
            }
            ctxHandled.add(node);
            addTodo(
              node,
              `\`${singleLine(parent.getText(sf), 40)}\` reads the Cloudflare step context. Only \`ctx.attempt\` (now \`getStepMetadata().attempt\`) and \`ctx.step.name\` carry over.`,
              notes
            );
            return;
          }
          ts.forEachChild(node, visitCtx);
        };
        visitCtx(callbackFn.body);
      }

      const analysis = analyzeCaptures({
        ts,
        sf,
        checker,
        target: callbackFn,
        scope: run,
        line,
        isHandled: (node) => handled.has(node) || ctxHandled.has(node),
        classify: (symbol) =>
          symbol === stepSymbol
            ? 'The step callback uses the step tools itself (a nested step), which cannot be lifted.'
            : undefined,
      });
      if (analysis.blockers.length) {
        for (const blocker of analysis.blockers) addTodo(call, blocker, notes);
        return;
      }
      for (const warning of analysis.warnings)
        notes.push({ severity: 'info', line: line(call), message: warning });

      const name = names.allocate(base);
      const range = blockRange(callbackFn.body);
      keptRanges.push(range);
      stepBodies.push(range);
      regions.push({
        start: range[0],
        end: range[1],
        from: contentIndent(callbackFn.body),
        to: indentUnit,
      });
      const params = analysis.captured
        .map((c) => (typed ? `${c.name}${INFER_MARK}` : c.name))
        .join(', ');
      let returnType = '';
      if (typed && callbackFn.type) {
        const typeText = callbackFn.type.getText(sf);
        keptRanges.push([callbackFn.type.getStart(sf), callbackFn.type.end]);
        returnType = `: ${/^Promise</.test(typeText) ? typeText : `Promise<${typeText}>`}`;
      } else if (typed && call.typeArguments?.[0]) {
        keptRanges.push([
          call.typeArguments[0].getStart(sf),
          call.typeArguments[0].end,
        ]);
        returnType = `: Promise<${call.typeArguments[0].getText(sf)}>`;
      }
      lifted.push(() =>
        stepFunction(
          name,
          params,
          renderBody(callbackFn.body),
          returnType,
          limit
        )
      );
      replace(
        call,
        () => `${name}(${analysis.captured.map((c) => c.argument).join(', ')})`
      );
      fn.steps.push({
        stepId: stepName ?? nameArg.getText(sf),
        dynamicId: stepName === undefined,
        functionName: name,
        line: line(call),
        source: 'step.do',
        captured: analysis.captured.map(({ name: n, declaredAt, kind }) => ({
          name: n,
          declaredAt,
          kind,
        })),
        inputs: 0,
      });
    }

    function migrateSleep(call: TS.CallExpression): void {
      const duration = call.arguments[1];
      if (!duration) {
        addTodo(call, '`step.sleep()` without a duration.', notes);
        return;
      }
      const sleep = wf('sleep');
      const arg = durationArg(duration, false);
      replace(call, () => `${sleep}(${arg()})`, [duration]);
    }

    function migrateSleepUntil(call: TS.CallExpression): void {
      const time = call.arguments[1];
      if (!time) {
        addTodo(call, '`step.sleepUntil()` without a time.', notes);
        return;
      }
      const sleep = wf('sleep');
      const isDate =
        ts.isNewExpression(time) &&
        ts.isIdentifier(time.expression) &&
        time.expression.text === 'Date';
      replace(
        call,
        () =>
          isDate
            ? `${sleep}(${render(time)})`
            : `${sleep}(new Date(${render(time)}))`,
        [time]
      );
    }

    function migrateWait(call: TS.CallExpression): void {
      const opts = call.arguments[1];
      const object = opts && resolveObject(opts);
      if (!object) {
        addTodo(
          call,
          '`step.waitForEvent()` options are not an object literal the codemod can read.',
          notes
        );
        return;
      }
      const type = getProperty(ts, object, 'type');
      if (!type) {
        addTodo(call, '`step.waitForEvent()` has no `type`.', notes);
        return;
      }
      const timeout = getProperty(ts, object, 'timeout');
      const events = needInbox();
      const typeArg =
        typed && call.typeArguments?.[0]
          ? `<${call.typeArguments[0].getText(sf)}>`
          : '';
      if (call.typeArguments?.[0])
        keptRanges.push([
          call.typeArguments[0].getStart(sf),
          call.typeArguments[0].end,
        ]);
      const timeoutArg = timeout
        ? durationArg(timeout, true)
        : () => String(DEFAULT_WAIT_TIMEOUT_MS);
      replace(
        call,
        () => `${events}.next${typeArg}(${render(type)}, ${timeoutArg()})`,
        [type, ...(timeout ? [timeout] : [])]
      );
      const typeName = literalText(ts, type) ?? type.getText(sf);
      fn.hooks.push({
        line: line(call),
        source: 'step.waitForEvent',
        name: typeName,
        token: `\`${fn.workflowName}:\${${eventName ?? 'event'}.instanceId}\``,
        resumeToken: `\`${fn.workflowName}:\${id}\``,
      });
    }
  }

  // --- Helpers for migrateClass ---------------------------------------------

  function ownThis(node: TS.Node, method: TS.Node): boolean {
    let current = node.parent;
    while (current && current !== method) {
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

  function blockRange(body: TS.ConciseBody): [number, number] {
    if (ts.isBlock(body)) return [body.getStart(sf) + 1, body.end - 1];
    return [body.getStart(sf), body.end];
  }

  function contentIndent(body: TS.ConciseBody): string {
    if (ts.isBlock(body) && body.statements.length > 0)
      return indentAt(text, body.statements[0].getStart(sf));
    if (ts.isBlock(body)) return indentAt(text, body.getStart(sf)) + indentUnit;
    return indentAt(text, body.getStart(sf));
  }

  function renderBody(body: TS.ConciseBody): string {
    if (ts.isBlock(body)) {
      const [start, end] = blockRange(body);
      return trimRendered(edits.render(start, end), indentUnit);
    }
    const inner = skipParens(ts, body);
    const expr = ts.isObjectLiteralExpression(inner) ? inner : body;
    return `${indentUnit}return ${render(expr)}${semi}`;
  }

  function stepFunction(
    name: string,
    params: string,
    body: string,
    returnType: string,
    limit: number | undefined
  ): string {
    let out =
      `async function ${name}(${params})${returnType} {\n` +
      `${indentUnit}${quote}use step${quote}${semi}\n` +
      (body ? `${body}\n` : '') +
      '}';
    if (limit !== undefined) out += `\n${name}.maxRetries = ${limit}${semi}`;
    return out;
  }

  /** An object literal, directly or through a `const` in this file. */
  function resolveObject(
    expr: TS.Expression
  ): TS.ObjectLiteralExpression | undefined {
    const node = resolveLiteral(expr);
    return node && ts.isObjectLiteralExpression(node) ? node : undefined;
  }

  /**
   * Follow an identifier to the initializer of the `const` that declares it.
   * An object is only read through when nothing else uses the const, since
   * `const` does not stop its properties from being changed.
   */
  function resolveLiteral(
    expr: TS.Expression,
    depth = 0
  ): TS.Expression | undefined {
    let node = skipParens(ts, expr);
    while (ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node))
      node = skipParens(ts, node.expression);
    if (!ts.isIdentifier(node)) return node;
    if (depth > 5) return undefined;
    const symbol = symbolOf(node);
    const declaration = symbol && firstDeclaration(symbol);
    if (
      !declaration ||
      declaration.getSourceFile() !== sf ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const)
    ) {
      return undefined;
    }
    const init = resolveLiteral(declaration.initializer, depth + 1);
    if (
      init &&
      (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init))
    ) {
      let uses = 0;
      const count = (n: TS.Node): void => {
        if (
          ts.isIdentifier(n) &&
          n !== declaration.name &&
          !isNonReferenceName(ts, n) &&
          symbolOf(n) === symbol
        )
          uses++;
        ts.forEachChild(n, count);
      };
      count(sf);
      if (uses > 1) return undefined;
    }
    return init;
  }

  /**
   * A Cloudflare duration as an argument for `sleep()` (milliseconds or an
   * `ms` string). `ms` reads "10 seconds" and "1 hour" the same way, but has
   * no months; a month is 30 days in Cloudflare. A duration only known at
   * runtime goes through a helper with Cloudflare's units.
   */
  function durationArg(node: TS.Expression, asMs: boolean): () => string {
    const value = skipParens(ts, node);
    if (ts.isNumericLiteral(value)) return () => value.text;
    const literal = literalText(ts, value);
    const match = literal !== undefined ? DURATION.exec(literal) : null;
    if (match) {
      const amount = Number(match[1]);
      const unit = match[2];
      if (asMs) return () => String(Math.round(amount * DURATION_UNITS[unit]));
      if (unit === 'month') return () => `${quote}${amount * 30} days${quote}`;
      return () =>
        `${quote}${amount} ${unit}${amount === 1 ? '' : 's'}${quote}`;
    }
    keptRanges.push([node.getStart(sf), node.end]);
    const helper = durationHelper();
    return () => `${helper}(${render(node)})`;
  }

  function durationHelper(): string {
    const name = 'cloudflareDuration';
    if (!helpers.has(name)) {
      const local = names.allocate(name, 'Helper');
      helpers.set(name, () => {
        const t = (s: string) => (typed ? s : '');
        const I = indentUnit;
        return (
          `/** A Cloudflare Workflows duration (milliseconds or "<n> <unit>"), in milliseconds. */\n` +
          `function ${local}(duration${t(': number | string')})${t(': number')} {\n` +
          `${I}if (typeof duration === 'number') return duration${semi}\n` +
          `${I}const units${t(': Record<string, number>')} = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31557600000 }${semi}\n` +
          `${I}const match = /^\\s*(\\d+(?:\\.\\d+)?)\\s+(second|minute|hour|day|week|month|year)s?\\s*$/.exec(duration)${semi}\n` +
          `${I}if (!match) throw new Error(\`Invalid duration: \${duration}\`)${semi}\n` +
          `${I}return Number(match[1]) * units[match[2]]${semi}\n` +
          '}'
        );
      });
      aliases.set('helper:duration', local);
    }
    return aliases.get('helper:duration') as string;
  }

  function workflowEventsHelper(): string {
    const existing = aliases.get('helper:events');
    if (existing) return existing;
    const local = names.allocate('workflowEvents', 'Inbox');
    aliases.set('helper:events', local);
    const createHook = wf('createHook');
    const sleep = wf('sleep');
    helpers.set('events', () => {
      const t = (s: string) => (typed ? s : '');
      const I = indentUnit;
      const event = t('{ type: string; payload: unknown; timestamp: Date }');
      return (
        `/**\n` +
        ` * The run's events, taken by type in the order they arrived, as\n` +
        ` * Cloudflare's step.waitForEvent() takes them. Start the run with\n` +
        ` * start(workflow, [event], { experimental_hook: { token } }) so events\n` +
        ` * sent before the run waits are kept, and send them with\n` +
        ` * resumeHook(token, { type, payload, timestamp: new Date() }).\n` +
        ` */\n` +
        `function ${local}(token${t(': string')}) {\n` +
        `${I}const events = ${createHook}${t(`<${event}>`)}({ token })[Symbol.asyncIterator]()${semi}\n` +
        `${I}const early${t(`: ${event}[]`)} = []${semi}\n` +
        `${I}let pending${t(`: Promise<IteratorResult<${event}>> | undefined`)}${semi}\n` +
        `${I}const timedOut = {}${semi}\n` +
        `${I}return {\n` +
        `${I}${I}async next${t('<T = any>')}(type${t(': string')}, timeoutMs${t(': number')})${t(': Promise<{ type: string; payload: T; timestamp: Date }>')} {\n` +
        `${I}${I}${I}const index = early.findIndex((event) => event.type === type)${semi}\n` +
        `${I}${I}${I}if (index !== -1) return early.splice(index, 1)[0]${t(' as { type: string; payload: T; timestamp: Date }')}${semi}\n` +
        `${I}${I}${I}const timeout = ${sleep}(timeoutMs).then(() => timedOut)${semi}\n` +
        `${I}${I}${I}for (;;) {\n` +
        `${I}${I}${I}${I}pending ??= events.next()${semi}\n` +
        `${I}${I}${I}${I}const result = await Promise.race([pending, timeout])${semi}\n` +
        `${I}${I}${I}${I}if (result === timedOut) {\n` +
        `${I}${I}${I}${I}${I}throw new Error(\`WorkflowTimeoutError: Execution timed out after \${timeoutMs}ms\`)${semi}\n` +
        `${I}${I}${I}${I}}\n` +
        `${I}${I}${I}${I}pending = undefined${semi}\n` +
        `${I}${I}${I}${I}const next = result${t(` as IteratorResult<${event}>`)}${semi}\n` +
        `${I}${I}${I}${I}if (next.done) throw new Error('The event hook closed')${semi}\n` +
        `${I}${I}${I}${I}if (next.value.type === type) return next.value${t(' as { type: string; payload: T; timestamp: Date }')}${semi}\n` +
        `${I}${I}${I}${I}early.push(next.value)${semi}\n` +
        `${I}${I}${I}}\n` +
        `${I}${I}},\n` +
        `${I}}${semi}\n` +
        '}'
      );
    });
    return local;
  }

  // --- NonRetryableError -> FatalError --------------------------------------

  if (nonRetryableSymbols.size) {
    const visit = (node: TS.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const symbol = symbolOf(node.expression);
        if (
          symbol &&
          nonRetryableSymbols.has(symbol) &&
          node.arguments &&
          node.arguments.length >= 2
        ) {
          // new NonRetryableError(message, name) -> new FatalError(message)
          const [message] = node.arguments;
          const fatal = wf('FatalError');
          replace(node, () => `new ${fatal}(${render(message)})`, [message]);
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
        if (symbol && nonRetryableSymbols.has(symbol)) {
          const fatal = wf('FatalError');
          replace(node, () => fatal);
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const statement of sf.statements)
      if (!ts.isImportDeclaration(statement)) visit(statement);
  }

  // --- App boundary: env.WORKFLOW.create(), instance.sendEvent() ----------

  const workflowBindings = new Set(context.workflows.map((w) => w.binding));
  const instanceSymbols = new Set<TS.Symbol>();
  const bindingOf = (expr: TS.Expression): string | undefined => {
    // env.BINDING or this.env.BINDING
    if (!ts.isPropertyAccessExpression(expr)) return undefined;
    const owner = expr.expression;
    const ownerText = owner.getText(sf);
    if (!/(^|\.)env$/.test(ownerText)) return undefined;
    const binding = expr.name.text;
    return workflowBindings.size === 0 || workflowBindings.has(binding)
      ? binding
      : undefined;
  };
  const visitBoundary = (node: TS.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      const binding = bindingOf(receiver);
      if (binding && ['create', 'createBatch', 'get'].includes(method)) {
        report.boundary.push({
          line: line(node),
          kind: method,
          names: [binding],
          text: singleLine(node.getText(sf)),
        });
        // const instance = await env.X.create(...)
        let up: TS.Node = node.parent;
        if (ts.isAwaitExpression(up)) up = up.parent;
        if (ts.isVariableDeclaration(up) && ts.isIdentifier(up.name)) {
          const symbol = symbolOf(up.name);
          if (symbol) instanceSymbols.add(symbol);
        }
      } else if (method === 'sendEvent') {
        const arg = node.arguments[0];
        const type =
          arg && ts.isObjectLiteralExpression(arg)
            ? getProperty(ts, arg, 'type')
            : undefined;
        report.boundary.push({
          line: line(node),
          kind: 'sendEvent',
          names: type ? [literalText(ts, type) ?? type.getText(sf)] : [],
          text: singleLine(node.getText(sf)),
        });
      } else if (
        ['status', 'pause', 'resume', 'terminate', 'restart'].includes(
          method
        ) &&
        ts.isIdentifier(receiver) &&
        (() => {
          const symbol = symbolOf(receiver);
          return !!symbol && instanceSymbols.has(symbol);
        })()
      ) {
        report.boundary.push({
          line: line(node),
          kind: method,
          names: [],
          text: singleLine(node.getText(sf)),
        });
      }
    }
    ts.forEachChild(node, visitBoundary);
  };
  visitBoundary(sf);

  // A file that still imports `cloudflare:*` modules cannot load on Node.
  if (report.functions.length) {
    for (const statement of sf.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text.startsWith('cloudflare:')
      ) {
        pendingCloudflareImports.push(statement);
      }
    }
  }

  // --- Re-indentation and TODO comments ------------------------------------

  const protectedLine = (pos: number) =>
    templateRanges.some(([s, e]) => pos > s && pos < e);
  const regionFor = (pos: number): Region | undefined => {
    let best: Region | undefined;
    for (const region of regions) {
      if (
        pos > region.start &&
        pos <= region.end &&
        (!best || region.end - region.start < best.end - best.start)
      )
        best = region;
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

  // --- Imports ---------------------------------------------------------------

  if (helpers.size) {
    const tail = text.endsWith('\n') ? '' : '\n';
    edits.insert(
      text.length,
      () => `${tail}\n${[...helpers.values()].map((h) => h()).join('\n\n')}\n`
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
  const references = (symbol: TS.Symbol, declaration: TS.Node) => {
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
    for (const statement of sf.statements)
      if (!ts.isImportDeclaration(statement)) visit(statement);
    return count;
  };

  // A module-level type only the removed classes used (`type Env = ...` for
  // `WorkflowEntrypoint<Env, P>`) goes with them.
  if (report.functions.length) {
    for (const statement of sf.statements) {
      if (
        !(
          ts.isTypeAliasDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement)
        ) ||
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        continue;
      }
      const symbol = symbolOf(statement.name);
      if (!symbol) continue;
      const { total, live } = references(symbol, statement.name);
      if (total > 0 && live === 0) {
        const start = statement.getStart(sf);
        let end = statement.end;
        if (text[end] === '\n') end++;
        edits.add(start, end, '');
      }
    }
  }

  const removedImports = new Set<TS.ImportDeclaration>();
  if (report.changed) {
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause)
        continue;
      const clause = statement.importClause;
      const named =
        clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings
          : undefined;
      if (!named) continue;
      // Imports only the removed code used go. In a migrated file, an unused
      // cloudflare:* import goes too: it cannot load outside Workers.
      const cloudflareModule =
        report.functions.length > 0 &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text.startsWith('cloudflare:');
      const removable = named.elements.filter((element) => {
        const symbol = symbolOf(element.name);
        if (!symbol) return false;
        const { total, live } = references(symbol, element.name);
        return live === 0 && (total > 0 || cloudflareModule);
      });
      if (!removable.length) continue;
      const remaining = named.elements.filter((e) => !removable.includes(e));
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
  for (const statement of pendingCloudflareImports) {
    if (removedImports.has(statement)) continue;
    report.notes.push({
      severity: 'todo',
      line: line(statement),
      message: `This file still imports \`${(statement.moduleSpecifier as TS.StringLiteral).text}\`, which only exists on Cloudflare, so it cannot be loaded as a workflow module. Move the Worker code (fetch handlers, Durable Objects) out of this file.`,
    });
  }

  if (imports.workflow.size || imports['workflow/api'].size) {
    report.changed = true;
    const lines: string[] = [];
    const addImport = (module: 'workflow' | 'workflow/api') => {
      const wanted = imports[module];
      if (!wanted.size) return;
      const current = sf.statements.find(
        (s): s is TS.ImportDeclaration =>
          ts.isImportDeclaration(s) &&
          ts.isStringLiteral(s.moduleSpecifier) &&
          s.moduleSpecifier.text === module &&
          !!s.importClause?.namedBindings &&
          ts.isNamedImports(s.importClause.namedBindings) &&
          !s.importClause.isTypeOnly
      );
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
    addImport('workflow');
    addImport('workflow/api');
    if (lines.length) {
      const all = sf.statements.filter(ts.isImportDeclaration);
      const kept = all.filter((i) => !removedImports.has(i));
      const anchor = kept[kept.length - 1];
      if (anchor) edits.insert(anchor.end, `\n${lines.join('\n')}`);
      else if (all.length)
        edits.insert(all[0].getStart(sf), `${lines.join('\n')}\n`);
      else
        edits.insert(
          sf.statements[0]?.getStart(sf) ?? 0,
          `${lines.join('\n')}\n\n`
        );
    }
  }

  const code = report.changed ? edits.apply() : text;
  return { code, report };
}
