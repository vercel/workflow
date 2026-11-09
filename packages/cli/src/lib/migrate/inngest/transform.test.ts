import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySwcTransform } from '@workflow/builders';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findTsconfig,
  loadTypeScript,
  migrateProject,
  resolveFiles,
} from './project.js';
import { renderMarkdown, summarize } from './report.js';
import type { FileReport } from './report-types.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, '..', '..', '..', '..');
const repoRoot = join(cliRoot, '..', '..');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface Migrated {
  dir: string;
  out: (file: string) => string;
  reports: FileReport[];
  report: (file: string) => FileReport;
  failed: Array<{ file: string; error: string }>;
}

async function migrate(files: Record<string, string>): Promise<Migrated> {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-migrate-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  const ts = loadTypeScript(dir);
  const tsconfig = findTsconfig(ts, dir);
  const inside = tsconfig?.startsWith(dir) ? tsconfig : undefined;
  const resolved = await resolveFiles(ts, dir, inside ? [] : ['.'], inside);
  const result = migrateProject({
    ts,
    cwd: dir,
    files: resolved,
    tsconfig: inside,
  });
  return {
    dir,
    out: (file) =>
      result.outputs.get(join(dir, file)) ??
      readFileSync(join(dir, file), 'utf8'),
    reports: result.reports,
    report: (file) => {
      const found = result.reports.find((r) => r.file === file);
      if (!found) throw new Error(`no report for ${file}`);
      return found;
    },
    failed: result.failed,
  };
}

const client = `import { Inngest } from 'inngest';\nexport const inngest = new Inngest({ id: 'app' });\n`;

/** Wrap a handler body in a v3-style Inngest function. */
const fn = (
  body: string,
  ctx = '{ event, step }',
  config = "{ id: 'my-fn' }"
) => `import { inngest } from './client';
import { db } from './db';

const LIMIT = 10;

export const myFn = inngest.createFunction(
  ${config},
  { event: 'app/thing' },
  async (${ctx}) => {
${body}
  }
);
`;

const db = `export const db = { get: async (id: string) => ({ id, n: 1 }), put: async (v: unknown) => v };\n`;

async function compiledSteps(code: string, name = 'functions.ts') {
  const { workflowManifest } = await applySwcTransform(
    name,
    code,
    'workflow',
    join(tmpdir(), name),
    tmpdir()
  );
  return {
    workflows: Object.values(workflowManifest.workflows ?? {}).flatMap((m) =>
      Object.keys(m)
    ),
    steps: Object.values(workflowManifest.steps ?? {}).flatMap((m) =>
      Object.keys(m)
    ),
  };
}

describe('workflow migrate inngest', () => {
  it('lifts step.run closures and passes what they captured as arguments', async () => {
    const m = await migrate({
      'client.ts': client,
      'db.ts': db,
      'functions.ts':
        fn(`    const user = await step.run('load-user', () => db.get(event.data.id));
    for (const tag of event.data.tags) {
      await step.run(\`tag-\${tag}\`, async () => {
        const id = user.id;
        return db.put({ id, tag, limit: LIMIT });
      });
    }
    return user;`),
    });
    const code = m.out('functions.ts');
    expect(code).toContain(
      "export async function myFn(event: any) {\n  'use workflow';"
    );
    expect(code).toContain('const user = await loadUser(event);');
    // The loop variable and the earlier step result are captured; the
    // module-level LIMIT and the imported db are not.
    const steps = m.report('functions.ts').functions[0].steps;
    expect(
      steps.map((s) => [
        s.stepId,
        s.functionName,
        s.captured.map((c) => c.name),
      ])
    ).toEqual([
      ['load-user', 'loadUser', ['event']],
      // In order of first use inside the closure.
      ['`tag-${tag}`', 'tagStep', ['user', 'tag']],
    ]);
    expect(code).toContain('await tagStep(user, tag);');
    expect(code).toMatch(
      /async function tagStep\(user: \{ id: string; n: number \}, tag: any\) \{\n {2}'use step';\n {2}const id = user\.id;/
    );
    expect(code).not.toContain("from './client'");
    expect(code).not.toContain('step.run');
    await expect(compiledSteps(code)).resolves.toEqual({
      workflows: ['myFn'],
      steps: ['loadUser', 'tagStep'],
    });
  });

  it('puts captured variables before step.run inputs', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts': fn(`    const factor = 2;
    return step.run('scale', (n: number, unit: string) => n * factor + unit, 21, 'x');`),
    });
    const code = m.out('functions.ts');
    expect(code).toContain("return scale(factor, 21, 'x');");
    expect(code).toContain(
      'async function scale(factor: number, n: number, unit: string) {'
    );
    expect(m.report('functions.ts').functions[0].steps[0].inputs).toBe(2);
  });

  it('refuses closures it cannot lift without changing behavior', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts': fn(`    let count = 0;
    await step.run('assign', () => { count++; });
    const helper = (x: number) => x + 1;
    await step.run('local-fn', () => helper(1));
    await step.run('nested', async () => step.run('inner', () => 1));
    await step.run('ok', () => count);`),
    });
    const code = m.out('functions.ts');
    const todos = m
      .report('functions.ts')
      .functions[0].notes.filter((n) => n.severity === 'todo');
    expect(todos.map((t) => t.message)).toEqual([
      expect.stringContaining('assigns to `count`'),
      expect.stringContaining(
        'calls `helper`, a function or class declared inside the handler'
      ),
      expect.stringContaining('inside another step closure'),
    ]);
    // Refused calls stay, with the TODO right above them.
    expect(code).toContain(
      "// TODO(workflow-migrate): The step closure assigns to `count`, declared outside it. Passed as an argument, the write would be lost: return the new value from the step instead.\n  await step.run('assign'"
    );
    expect(code).toContain("await step.run('local-fn'");
    expect(code).toContain("await step.run('nested'");
    // The safe one is still lifted.
    expect(code).toContain('await ok(count);');
  });

  it('does not capture shadowed names, globals, or module-level bindings', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts': fn(`    const id = event.data.id;
    return step.run('shadow', () => {
      const id = 'inner';
      return [id, LIMIT, JSON.stringify({ id }), new Date(0)];
    });`),
    });
    expect(m.report('functions.ts').functions[0].steps[0].captured).toEqual([]);
    expect(m.out('functions.ts')).toContain('return shadow();');
  });

  it('maps sleep, sleepUntil, waitForEvent, waitForSignal, invoke and fetch', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts': `import { inngest } from './client';

export const child = inngest.createFunction({ id: 'child' }, { event: 'app/child' }, async ({ event }) => {
  return { doubled: event.data.n * 2 };
});

export const parent = inngest.createFunction({ id: 'parent' }, { event: 'app/parent' }, async ({ event, step }) => {
  await step.sleep('nap', '5m');
  await step.sleepUntil('until', event.data.at);
  await step.sleepUntil('until-date', new Date(event.data.at));
  const approved = await step.waitForEvent('approve', { event: 'app/approved', timeout: '2d', match: 'data.orderId' });
  const shipped = await step.waitForSignal('ship', { signal: \`ship:\${event.data.orderId}\`, timeout: '1h', onConflict: 'replace' });
  const result = await step.invoke('call-child', { function: child, data: { n: 21 } });
  const res = await step.fetch('https://example.com');
  return { approved, shipped, result, status: res.status };
});
`,
    });
    const code = m.out('functions.ts');
    expect(code).toContain("await sleep('5m');");
    expect(code).toContain(
      'await sleep(new Date(event.data.at));\n  await sleep(new Date(event.data.at));'
    );
    expect(code).toContain(
      "const approved = await waitForHook(createHook({ token: `app/approved:parent:${event.data.orderId}` }), sleep('2d'));"
    );
    expect(code).toContain(
      "const shipped = await waitForHook(createHook({ token: `ship:${event.data.orderId}`, experimental_force: true }), sleep('1h'));"
    );
    expect(code).toContain(
      'const result = await start(child, [{ data: { n: 21 } }]).then((run) => run.returnValue);'
    );
    expect(code).toContain(
      "const res = await workflowFetch('https://example.com');"
    );
    expect(code).toContain(
      "import { createHook, fetch as workflowFetch, type Hook, sleep } from 'workflow';"
    );
    expect(code).toContain("import { start } from 'workflow/api';");
    // `onConflict: 'replace'`: a replaced wait times out instead of failing.
    expect(code).toContain(
      "import { HookForceClaimedError } from 'workflow/errors';"
    );
    expect(code).toContain(
      'if (!timeout || !HookForceClaimedError.is(error)) throw error;'
    );
    expect(
      m.report('functions.ts').functions[1].hooks.map((h) => h.token)
    ).toEqual([
      '`app/approved:parent:${event.data.orderId}`',
      '`ship:${event.data.orderId}`',
    ]);
    await expect(compiledSteps(code)).resolves.toMatchObject({
      workflows: ['child', 'parent'],
    });
  });

  it('turns the equality filters of step.waitForEvent() into hook tokens', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts': fn(`    const paid = eventType('app/a');
    const uuid = await step.run('uuid', () => crypto.randomUUID());
    const a = await step.waitForEvent('a', { event: paid, timeout: '1h', if: 'async.data.invoiceId == event.data.id' });
    const b = await step.waitForEvent('b', { event: 'app/b', timeout: '1h', if: \`async.data.uuid == "\${uuid}"\` });
    return [a, b];`),
    });
    const code = m.out('functions.ts');
    expect(code).toContain(
      "const a = await waitForHook(createHook({ token: `app/a:myFn:${event.data.id}` }), sleep('1h'));"
    );
    expect(code).toContain(
      "const b = await waitForHook(createHook({ token: `app/b:myFn:${uuid}` }), sleep('1h'));"
    );
    // The sender builds the token from the field of the event it sends.
    expect(
      m.report('functions.ts').functions[0].hooks.map((h) => h.resumeToken)
    ).toEqual([
      '`app/a:myFn:${event.data.invoiceId}`',
      '`app/b:myFn:${event.data.uuid}`',
    ]);
  });

  it('leaves event-bus and Inngest-only step tools in place with a TODO', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts':
        fn(`    await step.waitForEvent('any', { event: 'app/x', timeout: '1d' });
    await step.waitForEvent('cel', { event: 'app/y', timeout: '1d', if: 'async.data.total > 100' });
    await step.sendEvent('fan-out', { name: 'app/z', data: {} });
    await step.realtime.publish('pub', topic, 1);
    await helper(step);`),
    });
    const todos = m
      .report('functions.ts')
      .functions[0].notes.filter((n) => n.severity === 'todo')
      .map((n) => n.message);
    expect(todos).toEqual([
      expect.stringContaining('waits for any "app/x" event'),
      expect.stringContaining('with an `if` expression'),
      expect.stringContaining('step.sendEvent()'),
      expect.stringContaining('getWritable()'),
      expect.stringContaining('other than as a direct'),
    ]);
    expect(
      m.out('functions.ts').match(/TODO\(workflow-migrate\)/g)
    ).toHaveLength(5);
  });

  it('evaluates step.ai.wrap() inputs inside the step and returns only what is destructured', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts': `import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { inngest } from './client';

export const summarize = inngest.createFunction({ id: 'summarize' }, { event: 'doc/uploaded' }, async ({ event, step }) => {
  const doc = await step.run('load', () => ({ body: String(event.data.body) }));
  const { text, usage: tokens } = await step.ai.wrap('summarize', generateText, {
    model: openai('gpt-4o'),
    prompt: \`Summarize: \${doc.body}\`,
  });
  const whole = await step.ai.wrap('again', generateText, { model: openai('gpt-4o'), prompt: text });
  const { text: response } = await step.ai.wrap('alias', generateText, { model: openai('gpt-4o'), prompt: text });
  return { text, tokens, whole: whole.text };
});
`,
    });
    const code = m.out('functions.ts');
    // The model object is created inside the step, never passed to it.
    expect(code).toContain(
      'const { text, usage: tokens } = await summarizeStep(doc);'
    );
    expect(
      code
    ).toContain(`async function summarizeStep(doc: { body: string }) {
  'use step';
  const result = await generateText({
    model: openai('gpt-4o'),
    prompt: \`Summarize: \${doc.body}\`,
  });
  return { text: result.text, usage: result.usage };
}`);
    expect(code).toContain('const whole = await again(text);');
    // Copied into the step, so its import stays.
    expect(code).toContain("import { generateText } from 'ai';");
    // A field named like a captured parameter is read off the result.
    expect(code).toContain(`async function alias(text: any) {
  'use step';
  const result = await generateText({ model: openai('gpt-4o'), prompt: text });
  return { text: result.text };
}`);
    const notes = m
      .report('functions.ts')
      .functions[0].notes.map((n) => n.message);
    expect(notes).toEqual([
      expect.stringContaining('returns the whole result of `generateText()`'),
    ]);
  });

  it('flags code that cannot run in the workflow sandbox', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts': `import { inngest } from './client';

async function handle({ step }: any) {
  return step.run('x', () => 1);
}
export const byReference = inngest.createFunction({ id: 'by-ref' }, { event: 'a' }, handle);

export const direct = inngest.createFunction({ id: 'direct' }, { event: 'b' }, async ({ event, step }) => {
  const res = await fetch('https://example.com/' + event.id);
  return step.run('use', () => res.status + event.ts);
});
`,
    });
    const report = m.report('functions.ts');
    expect(report.notes.map((n) => n.message)).toEqual([
      expect.stringContaining('given its handler by reference'),
    ]);
    const notes = report.functions[0].notes.map((n) => n.message);
    expect(notes).toEqual([
      expect.stringContaining('reads `event.id`, `event.ts`'),
      expect.stringContaining(
        'The global fetch() is not available in a workflow function'
      ),
    ]);
  });

  it('removes imports only the removed Inngest code used, and keeps onFailure code', async () => {
    const m = await migrate({
      'client.ts': client,
      'events.ts': `export const created = { name: 'app/created' };\nexport type Item = { id: string };\n`,
      'alerts.ts': `export const alert = (e: unknown) => console.error(e);\n`,
      'functions.ts': `import { alert } from './alerts';
import { created, type Item } from './events';
import { inngest } from './client';

export const fn1 = inngest.createFunction(
  {
    id: 'fn1',
    triggers: [created],
    onFailure: async ({ error }) => {
      alert(error);
    },
  },
  async ({ event, step }) => {
    return step.run('count', (items: Item[]) => items.length, event.data.items);
  }
);
`,
    });
    const code = m.out('functions.ts');
    // `created` was only used by the trigger; `Item` is still used by the
    // lifted step's parameter, and `alert` by the kept onFailure handler.
    expect(code).toContain("import { type Item } from './events';");
    expect(code).toContain("import { alert } from './alerts';");
    expect(code).not.toContain("from './client'");
    expect(code).toContain(`const fn1OnFailure = async ({ error }) => {
  alert(error);
};`);
    expect(code).toContain('async function count(items: Item[]) {');
  });

  it('captures what parameter defaults and computed keys read', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts': fn(`    const field = event.data.field;
    const fallback = 7;
    const a = await step.run('read', ({ [field]: value }: Record<string, number>) => value, { [field]: 42 });
    const b = await step.run('fallback', ({ value = fallback }: { value?: number }) => value, {});
    return a + b;`),
    });
    const code = m.out('functions.ts');
    expect(code).toContain('const a = await read(field, { [field]: 42 });');
    expect(code).toContain(
      'async function read(field: any, { [field]: value }: Record<string, number>) {'
    );
    expect(code).toContain('const b = await fallbackStep(fallback, {});');
    expect(
      m
        .report('functions.ts')
        .functions[0].steps.map((s) => s.captured.map((c) => c.name))
    ).toEqual([['field'], ['fallback']]);
  });

  it('reads config through consts and refuses config it cannot read', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts': `import { inngest } from './client';

const NO_RETRIES = 0;
const config = { id: 'by-const', retries: NO_RETRIES, concurrency: { limit: 1 }, triggers: [{ event: 'a/b' }] } as const;
export const byConst = inngest.createFunction(config, async ({ step }) => step.run('flaky', () => 1));

declare const shared: { id: string; retries: 0 };
export const opaque = inngest.createFunction(shared, async ({ step }) => step.run('opaque-step', () => 1));

export const spread = inngest.createFunction({ ...shared, id: 'spread', retries: Number('2') }, async ({ step }) => step.run('spread-step', () => 1));
`,
    });
    const code = m.out('functions.ts');
    const [byConst, opaque, spread] = m.report('functions.ts').functions;
    expect(code).toContain('flaky.maxRetries = 0;');
    expect(byConst.triggers).toEqual([{ kind: 'event', value: 'a/b' }]);
    expect(byConst.inngestId).toBe('by-const');
    expect(byConst.config).toEqual({ concurrency: '{ limit: 1 }' });
    expect(opaque.notes.map((n) => n.message)).toEqual([
      expect.stringContaining('are not an object literal the codemod can read'),
    ]);
    expect(spread.notes.map((n) => n.message)).toEqual([
      expect.stringContaining('spread another object'),
      expect.stringContaining('is not a number the codemod can read'),
    ]);
  });

  it('imports Workflow APIs under an alias when the file already binds the name', async () => {
    const m = await migrate({
      'client.js': client,
      'functions.js': `import { inngest } from './client.js';

function sleep(value) {
  return value * 2;
}

export const doubler = inngest.createFunction({ id: 'doubler' }, { event: 'a/b' }, async ({ event, step }) => {
  await step.sleep('pause', '1s');
  return step.run('double', () => sleep(event.data.n));
});
`,
    });
    const code = m.out('functions.js');
    expect(code).toContain(
      "import { sleep as workflowSleep } from 'workflow';"
    );
    expect(code).toContain("await workflowSleep('1s');");
    expect(code).toContain('return sleep(event.data.n);');
    const file = join(m.dir, 'check.mjs');
    writeFileSync(file, code);
    // Parses as a module: no duplicate declaration of `sleep`.
    expect(() =>
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    ).not.toThrow();
  });

  it('turns function config into maxRetries and TODOs', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts': `import { inngest } from './client';

export default inngest.createFunction(
  { id: 'nightly-digest', retries: 7, concurrency: 5, idempotency: 'event.data.userId' },
  { cron: 'TZ=Europe/Paris 0 9 * * *' },
  async ({ step }) => {
    await step.run('send', () => 'sent');
  }
);
`,
    });
    const code = m.out('functions.ts');
    expect(code).toContain('export default async function nightlyDigest() {');
    expect(code).toContain('send.maxRetries = 7;');
    expect(code).toContain('// TODO(workflow-migrate): Inngest `concurrency`');
    expect(code).toContain(
      '// TODO(workflow-migrate): Inngest `idempotency` maps to an idempotent start'
    );
    expect(code).toContain('cron schedule TZ=Europe/Paris 0 9 * * *');
    const fnReport = m.report('functions.ts').functions[0];
    expect(fnReport.triggers).toEqual([
      { kind: 'cron', value: 'TZ=Europe/Paris 0 9 * * *' },
    ]);
    expect(fnReport.config).toEqual({
      concurrency: '5',
      idempotency: "'event.data.userId'",
    });
  });

  it('rewrites Inngest errors and handler context', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts': `import { NonRetriableError, RetryAfterError } from 'inngest';
import { inngest } from './client';

export const fn1 = inngest.createFunction({ id: 'fn1', triggers: [{ event: 'a/b' }] }, async ({ event, step, runId, logger, attempt }) => {
  logger.info('start', { runId });
  return step.run('work', () => {
    if (attempt > 1) throw new RetryAfterError('later', '30s', { cause: 1 });
    if (!event.data.ok) throw new NonRetriableError('bad', { cause: 2 });
    return runId;
  });
});
`,
    });
    const code = m.out('functions.ts');
    expect(code).toContain(
      "console.info('start', { runId: getWorkflowMetadata().workflowRunId });"
    );
    expect(code).toContain(
      "if (getStepMetadata().attempt - 1 > 1) throw new RetryableError('later', { retryAfter: '30s' });"
    );
    expect(code).toContain("throw new FatalError('bad');");
    expect(code).toContain('return getWorkflowMetadata().workflowRunId;');
    expect(code).toContain(
      "import { FatalError, getStepMetadata, getWorkflowMetadata, RetryableError } from 'workflow';"
    );
    expect(code).not.toContain("from 'inngest'");
    expect(m.report('functions.ts').functions[0].triggers).toEqual([
      { kind: 'event', value: 'a/b' },
    ]);
  });

  it('supports a handler that takes the context object', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts': fn(
        `    const out = await ctx.step.run('label', () => \`label-\${ctx.event.data.id}\`);
    return { out, run: ctx.runId };`,
        'ctx'
      ),
    });
    const code = m.out('functions.ts');
    expect(code).toContain('export async function myFn(event: any) {');
    expect(code).toContain('const out = await label(event);');
    expect(code).toContain(
      'return { out, run: getWorkflowMetadata().workflowRunId };'
    );
    expect(code).toContain('async function label(event: any) {');
  });

  it('writes plain JavaScript for .js files', async () => {
    const m = await migrate({
      'client.js': client.replace(': string', ''),
      'functions.js': `import { inngest } from './client.js';

export const hello = inngest.createFunction(
  { id: 'hello' },
  { event: 'app/hello' },
  async ({ event, step }) => {
    const greeting = await step.run('greet', () => \`Hello \${event.data.name}\`);
    await step.sleep('wait', 1000);
    return greeting;
  }
);
`,
    });
    const code = m.out('functions.js');
    expect(code).toContain('export async function hello(event) {');
    expect(code).toContain('async function greet(event) {');
    expect(code).not.toMatch(/: any|INFER|@wf/);
    await expect(compiledSteps(code, 'functions.js')).resolves.toEqual({
      workflows: ['hello'],
      steps: ['greet'],
    });
  });

  it('avoids names that would shadow globals or existing bindings', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts':
        fn(`    const a = await step.run('fetch', () => fetch('https://example.com').then((r) => r.status));
    const b = await step.run('fetch', () => 2);
    const myFnValue = await step.run('my-fn', () => 3);
    return [a, b, myFnValue];`),
    });
    const names = m
      .report('functions.ts')
      .functions[0].steps.map((s) => s.functionName);
    expect(names).toEqual(['fetchStep', 'fetchStep2', 'myFnStep']);
    // The global fetch inside the step is untouched.
    expect(m.out('functions.ts')).toContain(
      "return fetch('https://example.com').then((r) => r.status);"
    );
  });

  it('keeps multi-line template literals byte for byte when re-indenting', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts': fn(`    await step.run('render', () => {
      const html = \`<p>
    keep this indentation
</p>\`;
      return html;
    });`),
    });
    expect(m.out('functions.ts')).toContain(
      "  'use step';\n  const html = `<p>\n    keep this indentation\n</p>`;\n  return html;\n}"
    );
  });

  it('skips functions it cannot place at module scope', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts': `import { inngest } from './client';

export function makeFn(id: string) {
  return inngest.createFunction({ id }, { event: 'x' }, async ({ step }) => step.run('a', () => 1));
}

export const fns = [inngest.createFunction({ id: 'in-array' }, { event: 'y' }, async () => 1)];
`,
    });
    const notes = m.report('functions.ts').notes.map((n) => n.message);
    expect(notes).toEqual([
      expect.stringContaining('inside another function'),
      expect.stringContaining('not assigned to a variable'),
    ]);
    expect(m.out('functions.ts')).toContain('inngest.createFunction({ id }');
  });

  it('types captured parameters from the call site and drops annotations that do not resolve', async () => {
    const m = await migrate({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'es2022',
          module: 'esnext',
          moduleResolution: 'bundler',
          skipLibCheck: true,
        },
      }),
      'node_modules/inngest/package.json': JSON.stringify({
        name: 'inngest',
        types: 'index.d.ts',
      }),
      'node_modules/inngest/index.d.ts': `interface ReceivedEvent<N extends string> { name: N; data: { orderId: string; total: number }; id: string; ts: number }
interface StepTools { run<T>(id: string, fn: () => T | Promise<T>): Promise<T> }
export declare class Inngest {
  constructor(options: { id: string });
  createFunction<N extends string, R>(options: { id: string }, trigger: { event: N }, handler: (ctx: { event: ReceivedEvent<N>; step: StepTools }) => Promise<R>): unknown;
}
`,
      'src/client.ts': client,
      'src/functions.ts': `import { inngest } from './client';

type Line = { sku: string; qty: number };

export const dataOnly = inngest.createFunction({ id: 'data-only' }, { event: 'shop/order' }, async ({ event, step }) => {
  const lines: Line[] = await step.run('load', () => [{ sku: event.data.orderId, qty: 1 }]);
  return step.run('sum', () => lines.reduce((n, l) => n + l.qty, event.data.total));
});

export const readsName = inngest.createFunction({ id: 'reads-name' }, { event: 'shop/order' }, async ({ event, step }) => {
  return step.run('name', () => event.name);
});
`,
    });
    const code = m.out('src/functions.ts');
    // Only `event.data` is read: the parameter is typed as just that.
    expect(code).toContain(
      'export async function dataOnly(event: { data: { orderId: string; total: number } }) {'
    );
    expect(code).toContain(
      'async function sum(lines: Line[], event: { data: { orderId: string; total: number } }) {'
    );
    // `ReceivedEvent` is not exported by the package, so the annotation is
    // rejected by the checker and replaced with `any`.
    expect(code).toContain('export async function readsName(event: any) {');
    expect(code).not.toContain('@wf');
  });

  it('reports inngest.send() and serve() calls with suggested replacements', async () => {
    const m = await migrate({
      'client.ts': client,
      'functions.ts': fn(
        `    await step.waitForEvent('wait', { event: 'app/approved', timeout: '1d', match: 'data.id' });`,
        '{ event, step }',
        "{ id: 'my-fn', idempotency: 'event.data.id' }"
      ),
      'route.ts': `import { serve } from 'inngest/next';
import { inngest } from './client';
import { myFn } from './functions';
export const { GET, POST, PUT } = serve({ client: inngest, functions: [myFn] });
`,
      'send.ts': `import { inngest } from './client';
export async function POST() {
  await inngest.send({ name: 'app/thing', data: { id: '1' } });
  await inngest.send([{ name: 'app/approved', data: { id: '1' } }]);
  await inngest.send({ name: 'app/nobody', data: {} });
}
`,
    });
    expect(m.report('route.ts').boundary.map((b) => b.kind)).toEqual(['serve']);
    expect(m.report('send.ts').boundary.map((b) => b.names)).toEqual([
      ['app/thing'],
      ['app/approved'],
      ['app/nobody'],
    ]);
    expect(m.report('send.ts').changed).toBe(false);
    const markdown = renderMarkdown(m.reports);
    expect(markdown).toContain(
      "call `start(myFn, [{ name: 'app/thing', data }])` from `workflow/api`, importing `myFn` from `functions.ts`, and pass `{ experimental_hook: { token } }`"
    );
    expect(markdown).toContain(
      '`app/approved` resumed a waiting `myFn` run: call `resumeHook(token, event)` from `workflow/api`, where `event` is the object you sent and the token is `` `app/approved:myFn:${event.data.id}` ``.'
    );
    expect(markdown).toContain('No migrated function listens for `app/nobody`');
    expect(markdown).toContain('Delete this route');
    expect(summarize(m.reports)).toMatchObject({
      filesChanged: 1,
      functions: 1,
      steps: 0,
      hooks: 1,
    });
  });

  it('produces the workflow committed in the vitest workbench', async () => {
    const fixtureDir = join(cliRoot, 'tests', 'fixture', 'inngest', 'order');
    const m = await migrate({
      'client.ts': readFileSync(join(fixtureDir, 'client.ts'), 'utf8'),
      'functions.ts': readFileSync(join(fixtureDir, 'functions.ts'), 'utf8'),
    });
    expect(m.failed).toEqual([]);
    // The only TODOs are the one-owner caveat of each waitForEvent() token.
    const todos = m.reports
      .flatMap((r) => r.functions.flatMap((f) => f.notes))
      .filter((n) => n.severity === 'todo')
      .map((n) => n.message);
    expect(todos).toHaveLength(3);
    for (const todo of todos)
      expect(todo).toContain('Only one run at a time can own this hook token');
    const committedPath = join(
      repoRoot,
      'workbench',
      'vitest',
      'workflows',
      'inngest-migrated.ts'
    );
    const output = m.out('functions.ts');
    if (process.env.UPDATE_INNGEST_FIXTURE) {
      // Run `pnpm format` afterwards; the comparison ignores formatting.
      writeFileSync(committedPath, output);
    }
    // The committed copy is formatted with Biome; compare what formatting
    // cannot change.
    const normalize = (code: string) =>
      code
        .replace(/\s+/g, '')
        .replace(/,([)\]}])/g, '$1')
        .replace(/\(([)\]}])/g, '($1');
    expect(normalize(readFileSync(committedPath, 'utf8'))).toBe(
      normalize(output)
    );
  });
});
