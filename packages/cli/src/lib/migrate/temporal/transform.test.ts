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
} from '../project.js';
import type { FileReport } from '../report-types.js';
import { summarize } from '../summary.js';
import { temporalFramework } from './index.js';
import { renderMarkdown } from './report.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'workflow-migrate-temporal-'));
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
    framework: temporalFramework,
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

const todos = (report: FileReport) =>
  [...report.notes, ...report.functions.flatMap((f) => f.notes)]
    .filter((n) => n.severity === 'todo')
    .map((n) => n.message);

async function manifest(code: string, name: string) {
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

const activities = `export async function greet(name: string): Promise<string> {
  return \`Hello, \${name}!\`;
}

export const shout = async (text: string) => text.toUpperCase();

export function syncLength(text: string): number {
  return text.length;
}
`;

describe('workflow migrate temporal', () => {
  it('turns proxied activities into steps and imports them directly', async () => {
    const m = await migrate({
      'activities.ts': activities,
      'workflows.ts': `import { proxyActivities } from '@temporalio/workflow';
import type * as activities from './activities';

const { greet, shout } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 4, backoffCoefficient: 3 },
});

const { syncLength: lengthOf } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

export async function greeting(name: string): Promise<string> {
  const text = await greet(name);
  const loud = await shout(text);
  return \`\${loud} (\${await lengthOf(loud)})\`;
}
`,
    });
    const workflows = m.out('workflows.ts');
    expect(workflows).toContain(
      "import { greet, shout, syncLength as lengthOf } from './activities';"
    );
    expect(workflows).not.toContain('proxyActivities');
    expect(workflows).not.toContain('@temporalio/workflow');
    expect(workflows).toContain(
      "export async function greeting(name: string): Promise<string> {\n  'use workflow';"
    );
    const acts = m.out('activities.ts');
    expect(acts).toContain(
      "export async function greet(name: string): Promise<string> {\n  'use step';"
    );
    // maximumAttempts 4 -> 3 retries.
    expect(acts).toContain('greet.maxRetries = 3;');
    // An expression-bodied arrow gets a block for the directive.
    expect(acts).toContain(
      "export const shout = async (text: string) => {\n  'use step';\n  return text.toUpperCase();\n};"
    );
    expect(acts).toContain('shout.maxRetries = 3;');
    // A synchronous activity becomes async.
    expect(acts).toContain(
      "export async function syncLength(text: string): Promise<number> {\n  'use step';"
    );
    // No maximumAttempts: Temporal retried without limit.
    expect(todos(m.report('activities.ts'))).toEqual([
      expect.stringContaining('Temporal retried `syncLength` without limit'),
    ]);
    const notes = m.report('activities.ts').notes.map((n) => n.message);
    expect(notes).toContainEqual(
      expect.stringContaining(
        '`backoffCoefficient` settings have no equivalent'
      )
    );
    await expect(manifest(acts, 'activities.ts')).resolves.toMatchObject({
      steps: ['greet', 'shout', 'syncLength'],
    });
    await expect(manifest(workflows, 'workflows.ts')).resolves.toMatchObject({
      workflows: ['greeting'],
    });
  });

  it('flags activities proxied with different retry policies', async () => {
    const m = await migrate({
      'activities.ts': activities,
      'a.ts': `import { proxyActivities } from '@temporalio/workflow';
import type * as acts from './activities';
const { greet } = proxyActivities<typeof acts>({ startToCloseTimeout: '1m', retry: { maximumAttempts: 1 } });
export async function a() { return greet('a'); }
`,
      'b.ts': `import { proxyActivities } from '@temporalio/workflow';
import type * as acts from './activities';
const { greet } = proxyActivities<typeof acts>({ startToCloseTimeout: '1m', retry: { maximumAttempts: 5 } });
export async function b() { return greet('b'); }
`,
    });
    expect(todos(m.report('activities.ts'))).toEqual([
      expect.stringContaining(
        '`greet` is proxied with different retry policies'
      ),
    ]);
    expect(m.out('activities.ts')).not.toContain('greet.maxRetries =');
  });

  it('turns a proxy object into a namespace import', async () => {
    const m = await migrate({
      'activities.ts': activities,
      'workflows.ts': `import * as wf from '@temporalio/workflow';
import type * as activities from './activities';

const acts = wf.proxyActivities<typeof activities>({ startToCloseTimeout: '1m', retry: { maximumAttempts: 2 } });

export async function run(name: string) {
  await wf.sleep('5 minutes');
  return acts.greet(name);
}
`,
    });
    const code = m.out('workflows.ts');
    expect(code).toContain("import * as acts from './activities';");
    expect(code).toContain("await sleep('5 minutes');");
    expect(code).toContain("import { sleep } from 'workflow';");
    expect(code).not.toContain('@temporalio');
    expect(m.out('activities.ts')).toContain('greet.maxRetries = 1;');
  });

  it('turns signals into hooks and condition() into a re-checked wait', async () => {
    const m = await migrate({
      'workflows.ts': `import { condition, defineQuery, defineSignal, setHandler } from '@temporalio/workflow';

export const approve = defineSignal<[boolean]>('approve');
export const status = defineQuery<string>('status');

export async function approval(): Promise<string> {
  let approved: boolean | undefined;
  setHandler(approve, (ok) => {
    approved = ok;
  });
  setHandler(status, () => String(approved));
  if (!(await condition(() => approved !== undefined, '1 day'))) return 'expired';
  return approved ? 'approved' : 'rejected';
}

export async function noSignals(): Promise<void> {
  let done = false;
  await condition(() => done);
  done = true;
}
`,
    });
    const code = m.out('workflows.ts');
    expect(code).toContain(
      "export const approve = { type: 'signal', name: 'approve' } as const;"
    );
    expect(code).toContain(`export async function approval(): Promise<string> {
  'use workflow';
  const signals = new TemporalSignals();
  const approveHook = signals.hook<[boolean]>(approve.name);`);
    expect(code).toContain('signals.handle(approveHook, (ok) => {');
    expect(code).toContain(
      "if (!(await signals.condition(() => approved !== undefined, () => sleep('1 day')))) return 'expired';"
    );
    expect(code).toContain('class TemporalSignals {');
    expect(code).toContain(
      "import { createHook, getWorkflowMetadata, type Hook, sleep } from 'workflow';"
    );
    const report = m.report('workflows.ts');
    expect(report.functions[0].hooks.map((h) => h.token)).toEqual([
      '`${runId}:approve`',
    ]);
    expect(todos(report)).toEqual([
      expect.stringContaining('Queries have no equivalent'),
      expect.stringContaining(
        'Queries read workflow state while the run is going'
      ),
      expect.stringContaining(
        '`condition()` waits for state no signal handler'
      ),
    ]);
  });

  it('handles signals defined in a shared module, and arrow workflows', async () => {
    const m = await migrate({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'es2022',
          module: 'esnext',
          moduleResolution: 'bundler',
          skipLibCheck: true,
          noEmit: true,
        },
      }),
      'src/types.ts': 'export type Order = { id: string; amount: number };\n',
      'src/shared.ts': `import { defineSignal } from '@temporalio/workflow';
import type { Order } from './types';
export const addOrder = defineSignal<[Order]>('add-order');
export const finish = defineSignal('finish');
`,
      'src/workflows.ts': `import { condition, setHandler } from '@temporalio/workflow';
import { addOrder, finish } from './shared';

export const collect = async (): Promise<number> => {
  let total = 0;
  let done = false;
  setHandler(addOrder, (order) => {
    total += order.amount;
  });
  setHandler(finish, () => {
    done = true;
  });
  await condition(() => done);
  return total;
};

export const noop = async () => 1;
`,
    });
    expect(m.out('src/shared.ts')).toContain(
      "export const addOrder = { type: 'signal', name: 'add-order' } as const;"
    );
    const code = m.out('src/workflows.ts');
    expect(
      code
    ).toContain(`export const collect = async (): Promise<number> => {
  'use workflow';
  const signals = new TemporalSignals();`);
    // The args type comes from the definition in shared.ts; it names a type
    // this file does not import, so the checker drops it and the helper's
    // any[] default applies rather than unknown.
    expect(code).toContain('const addOrderHook = signals.hook(addOrder.name);');
    expect(code).toContain('const finishHook = signals.hook(finish.name);');
    expect(code).toContain('await signals.condition(() => done);');
    expect(code).toContain(
      "export const noop = async () => {\n  'use workflow';\n  return 1;\n};"
    );
    expect(
      m.report('src/workflows.ts').functions[0].hooks.map((h) => h.name)
    ).toEqual(['add-order', 'finish']);
  });

  it('maps child workflows, workflowInfo, uuid4, patched and log', async () => {
    const m = await migrate({
      'workflows.ts': `import { continueAsNew, deprecatePatch, executeChild, log, patched, startChild, uuid4, workflowInfo } from '@temporalio/workflow';

export async function child(n: number): Promise<number> {
  return n * 2;
}

export async function parent(n: number) {
  deprecatePatch('old');
  const a = await executeChild(child, { args: [n], workflowId: \`child-\${n}\`, taskQueue: 'q' });
  const handle = await startChild(child, { args: [n + 1] });
  const b = await handle.result();
  log.info('ids', { run: workflowInfo().runId, id: uuid4() });
  const branch = patched('fast') ? 'fast' : 'slow';
  if (n > 10 || workflowInfo().continueAsNewSuggested) await continueAsNew<typeof parent>(n - 1);
  return { a, b, branch, type: workflowInfo().workflowType, wid: workflowInfo().workflowId };
}
`,
    });
    const code = m.out('workflows.ts');
    expect(code).toContain(
      'const a = await start(child, [n], { experimental_hook: { token: `child-${n}` } }).then((run) => run.returnValue);'
    );
    expect(code).toContain('const handle = await start(child, [n + 1]);');
    expect(code).toContain('const b = await handle.returnValue;');
    expect(code).toContain(
      "console.info('ids', { run: getWorkflowMetadata().workflowRunId, id: crypto.randomUUID() });"
    );
    expect(code).toContain("const branch = 'fast';");
    expect(code).not.toContain('deprecatePatch');
    expect(code).toContain(
      "type: getWorkflowMetadata().workflowName.replace(/^.*\\//, '')"
    );
    expect(todos(m.report('workflows.ts'))).toEqual([
      expect.stringContaining(
        '`workflowInfo().continueAsNewSuggested` only decided when to continue-as-new'
      ),
      expect.stringContaining('continueAsNew() is not needed'),
      expect.stringContaining('`workflowInfo().workflowId` has no equivalent'),
    ]);
    await expect(manifest(code, 'workflows.ts')).resolves.toMatchObject({
      workflows: ['child', 'parent'],
    });
  });

  it('maps ApplicationFailure and the activity context', async () => {
    const m = await migrate({
      'activities.ts': `import { ApplicationFailure, Context, heartbeat } from '@temporalio/activity';

export async function charge(amount: number) {
  heartbeat('charging');
  Context.current().heartbeat();
  const attempt = Context.current().info.attempt;
  if (amount < 0) throw ApplicationFailure.nonRetryable('negative', 'Validation');
  if (attempt === 1) throw ApplicationFailure.create({ message: 'busy', nextRetryDelay: '2s' });
  if (attempt === 2) throw ApplicationFailure.create({ message: 'nope', nonRetryable: true });
  if (attempt === 3) throw ApplicationFailure.retryable('again');
  const signal = Context.current().cancellationSignal;
  return { amount, attempt, signal };
}
`,
      'workflows.ts': `import { proxyActivities } from '@temporalio/workflow';
import type * as activities from './activities';
const { charge } = proxyActivities<typeof activities>({ startToCloseTimeout: '1m', retry: { maximumAttempts: 5 } });
export async function pay(amount: number) {
  return charge(amount);
}
`,
    });
    const code = m.out('activities.ts');
    expect(code).not.toMatch(/heartbeat\(/);
    expect(code).toContain('const attempt = getStepMetadata().attempt;');
    expect(code).toContain("throw new FatalError('negative');");
    expect(code).toContain(
      "throw new RetryableError('busy', { retryAfter: '2s' });"
    );
    expect(code).toContain("throw new FatalError('nope');");
    expect(code).toContain("throw new Error('again');");
    expect(code).toContain(
      "import { FatalError, getStepMetadata, RetryableError } from 'workflow';"
    );
    expect(todos(m.report('activities.ts'))).toEqual([
      expect.stringContaining('Context.current()'),
    ]);
  });

  it('writes plain JavaScript for .js files', async () => {
    const m = await migrate({
      'activities.js': `export async function greet(name) { return \`Hi \${name}\`; }\n`,
      'workflows.js': `import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';

const { greet } = proxyActivities({ startToCloseTimeout: '1m' });
const go = defineSignal('go');

export async function hello(name) {
  let ready = false;
  setHandler(go, () => { ready = true; });
  await condition(() => ready, '1h');
  return name;
}
`,
    });
    const code = m.out('workflows.js');
    expect(code).toContain("const go = { type: 'signal', name: 'go' };");
    expect(code).toContain('class TemporalSignals {');
    expect(code).not.toMatch(/: (string|boolean|Promise|Hook)|<Args|as const/);
    // Untyped proxies name no module: the activities stay a TODO.
    expect(todos(m.report('workflows.js'))).toEqual([
      expect.stringContaining('does not name its activities module'),
    ]);
    const file = join(m.dir, 'check.mjs');
    writeFileSync(file, code);
    expect(() =>
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    ).not.toThrow();
  });

  it('reports the client and worker calls with their replacements', async () => {
    const m = await migrate({
      'workflows.ts': `import { defineSignal, setHandler, condition } from '@temporalio/workflow';
export const go = defineSignal<[string]>('go');
export async function waiter(): Promise<string> {
  let value = '';
  setHandler(go, (v) => { value = v; });
  await condition(() => value !== '');
  return value;
}
`,
      'client.ts': `import { Client } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { go, waiter } from './workflows';

export async function main(client: Client) {
  const worker = await Worker.create({ taskQueue: 'q', workflowsPath: './workflows' });
  void worker;
  const handle = await client.workflow.start(waiter, { taskQueue: 'q', workflowId: 'w-1' });
  await handle.signal(go, 'now');
  await client.schedule.create({
    scheduleId: 'nightly',
    spec: { cronExpressions: ['0 2 * * *'] },
    action: { type: 'startWorkflow', workflowType: waiter, taskQueue: 'q' },
  });
  return client.workflow.getHandle('w-1').result();
}
`,
    });
    expect(m.report('client.ts').boundary.map((b) => b.kind)).toEqual([
      'worker',
      'start',
      'signal',
      'schedule',
      'getHandle',
    ]);
    expect(m.report('client.ts').changed).toBe(false);
    const markdown = renderMarkdown(m.reports);
    expect(markdown).toContain('## Signal routing');
    expect(markdown).toContain(
      '| `waiter` | `go` | `resumeHook(token, args)` with `` `${run.runId}:go` `` |'
    );
    expect(markdown).toContain('Delete the worker');
    expect(markdown).toContain(
      'Replace the Temporal Schedule with a Vercel Schedule (https://vercel.com/docs/schedules/workflows)'
    );
    expect(markdown).toContain(
      '`start(workflow, args, { experimental_hook: { token: workflowId } })`'
    );
  });

  it('produces the workflow committed in the vitest workbench', async () => {
    const fixtureDir = join(cliRoot, 'tests', 'fixture', 'temporal', 'order');
    const m = await migrate({
      'activities.ts': readFileSync(join(fixtureDir, 'activities.ts'), 'utf8'),
      'workflows.ts': readFileSync(join(fixtureDir, 'workflows.ts'), 'utf8'),
    });
    expect(m.failed).toEqual([]);
    expect(summarize(m.reports)).toMatchObject({
      functions: 11,
      steps: 6,
      hooks: 2,
      todos: 0,
    });
    const committed = join(
      repoRoot,
      'workbench',
      'vitest',
      'workflows',
      'temporal-migrated'
    );
    // The committed copy is formatted and import-sorted by Biome; compare
    // what neither can change.
    const normalize = (code: string) => {
      const imports: string[] = [];
      const body = code.replace(
        /^import\s[^;]*?from\s+['"][^'"]+['"];?/gm,
        (statement) => {
          imports.push(
            statement.replace(/\s+/g, ' ').replace(
              /\{([^}]*)\}/,
              (_, names: string) =>
                `{${names
                  .split(',')
                  .map((n) => n.trim())
                  .filter(Boolean)
                  .sort()
                  .join(',')}}`
            )
          );
          return '';
        }
      );
      return [...imports.sort(), body]
        .join('\n')
        .replace(/\s+/g, '')
        .replace(/;}/g, '}')
        .replace(/,([)\]}])/g, '$1')
        .replace(/\(([)\]}])/g, '($1');
    };
    for (const file of ['activities.ts', 'workflows.ts']) {
      const output = m.out(file);
      if (process.env.UPDATE_TEMPORAL_FIXTURE) {
        // Run `pnpm format` afterwards; the comparison ignores formatting.
        mkdirSync(committed, { recursive: true });
        writeFileSync(join(committed, file), output);
      }
      expect(normalize(readFileSync(join(committed, file), 'utf8'))).toBe(
        normalize(output)
      );
    }
  });
});
