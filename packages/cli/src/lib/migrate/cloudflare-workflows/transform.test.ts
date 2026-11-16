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
import { cloudflareWorkflowsFramework } from './index.js';
import {
  parseToml,
  readWranglerConfig,
  stripJsonComments,
} from './wrangler.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, '..', '..', '..', '..');
const repoRoot = join(cliRoot, '..', '..');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function migrate(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-migrate-cf-'));
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
    framework: cloudflareWorkflowsFramework,
  });
  return {
    dir,
    out: (file: string) =>
      result.outputs.get(join(dir, file)) ??
      readFileSync(join(dir, file), 'utf8'),
    reports: result.reports,
    report: (file: string): FileReport => {
      const found = result.reports.find((r) => r.file === file);
      if (!found) throw new Error(`no report for ${file}`);
      return found;
    },
    markdown: () =>
      cloudflareWorkflowsFramework.renderMarkdown(
        result.reports,
        result.failed
      ),
    failed: result.failed,
  };
}

const wrangler = JSON.stringify({
  name: 'app',
  vars: { GREETING: 'hello' },
  kv_namespaces: [{ binding: 'CACHE', id: 'x' }],
  workflows: [{ name: 'my', binding: 'MY_WORKFLOW', class_name: 'MyWorkflow' }],
});

const header = `import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
`;

/** One Workflow class with this `run()` body. */
const workflow = (
  body: string,
  params = '{ id: string; items: string[] }'
) => `${header}
type Env = { GREETING: string; CACHE: KVNamespace };
const LIMIT = 10;

export class MyWorkflow extends WorkflowEntrypoint<Env, ${params}> {
  async run(event: WorkflowEvent<${params}>, step: WorkflowStep) {
${body}
  }
}
`;

async function compiled(code: string, name = 'workflows.ts') {
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

describe('workflow migrate cloudflare-workflows', () => {
  it('points Cron Triggers and the scheduled() handler at Vercel Schedules', async () => {
    for (const config of [
      {
        name: 'wrangler.jsonc',
        text: JSON.stringify({
          name: 'app',
          triggers: { crons: ['0 2 * * *', '*/15 * * * *'] },
          workflows: [
            { name: 'my', binding: 'MY_WORKFLOW', class_name: 'MyWorkflow' },
          ],
        }),
      },
      {
        name: 'wrangler.toml',
        text: `name = "app"

[triggers]
crons = ["0 2 * * *", "*/15 * * * *"]

[[workflows]]
name = "my"
binding = "MY_WORKFLOW"
class_name = "MyWorkflow"
`,
      },
    ]) {
      const m = await migrate({
        [config.name]: config.text,
        'workflows.ts': workflow(
          "    return step.do('one', async () => event.payload.id);"
        ),
        'index.ts': `export default {
  async scheduled(controller: ScheduledController, env: { MY_WORKFLOW: Workflow }) {
    await env.MY_WORKFLOW.create({ params: { id: String(controller.scheduledTime), items: [] } });
  },
};
`,
      });
      const todos = m.report('index.ts').notes.map((n) => n.message);
      expect(todos).toEqual([
        expect.stringContaining(
          `This scheduled() handler runs on Cloudflare Cron Triggers ("0 2 * * *", "*/15 * * * *" in ${config.name}, UTC). Replace it with a Vercel Schedule`
        ),
      ]);
      expect(m.out('index.ts')).toContain(
        '// TODO(workflow-migrate): This scheduled() handler runs on Cloudflare Cron Triggers'
      );
      const markdown = m.markdown();
      expect(markdown).toContain(`## Cron Triggers in \`${config.name}\``);
      expect(markdown).toContain('"schedule": "*/15 * * * *"');
      expect(markdown).toContain('https://vercel.com/docs/schedules/workflows');
    }
  });

  it('lifts step.do() callbacks and passes what they captured as arguments', async () => {
    const m = await migrate({
      'wrangler.json': wrangler,
      'workflows.ts':
        workflow(`    const user = await step.do('load user', async () => ({ id: event.payload.id, limit: LIMIT }));
    for (const item of event.payload.items) {
      await step.do(\`tag \${item}\`, { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' } }, async () => {
        return \`\${user.id}:\${item}\`;
      });
    }
    return user;`),
    });
    const code = m.out('workflows.ts');
    expect(code).toContain(
      "export async function MyWorkflow(event: { payload: { id: string; items: string[] }; timestamp: Date; instanceId: string; workflowName: string }) {\n  'use workflow';"
    );
    expect(code).toContain('const user = await loadUser(event);');
    expect(code).toContain('await tag(user, item);');
    expect(code).toContain(
      'async function tag(user: { id: string; limit: number }, item: string) {'
    );
    // Cloudflare's default is 5 retries; an explicit limit carries over.
    expect(code).toContain('loadUser.maxRetries = 5;');
    expect(code).toContain('tag.maxRetries = 2;');
    expect(code).not.toContain('cloudflare:');
    const fn = m.report('workflows.ts').functions[0];
    expect(
      fn.steps.map((s) => [
        s.stepId,
        s.functionName,
        s.captured.map((c) => c.name),
      ])
    ).toEqual([
      ['load user', 'loadUser', ['event']],
      ['`tag ${item}`', 'tag', ['user', 'item']],
    ]);
    expect(fn.notes.map((n) => n.message)).toEqual([
      expect.stringContaining(
        "The retry delay (delay: '5 seconds', backoff: 'exponential') is not carried over"
      ),
    ]);
    await expect(compiled(code)).resolves.toEqual({
      workflows: ['MyWorkflow'],
      steps: ['loadUser', 'tag'],
    });
  });

  it('carries over ctx.attempt and ctx.step.name, and reads vars from process.env in steps', async () => {
    const m = await migrate({
      'wrangler.json': wrangler,
      'workflows.ts':
        workflow(`    const greeting = await step.do('greet', async (ctx) => {
      if (ctx.attempt < 2) throw new Error('again');
      return \`\${this.env.GREETING} from \${ctx.step.name}\`;
    });
    return greeting;`),
    });
    const code = m.out('workflows.ts');
    expect(code).toContain(
      "if (getStepMetadata().attempt < 2) throw new Error('again');"
    );
    expect(code).toContain("return `${process.env.GREETING} from ${'greet'}`;");
    expect(code).toContain("import { getStepMetadata } from 'workflow';");
    expect(m.report('workflows.ts').functions[0].notes).toEqual([]);
  });

  it('leaves bindings, the Worker context and vars read outside steps under a TODO', async () => {
    const m = await migrate({
      'wrangler.json': wrangler,
      'workflows.ts':
        workflow(`    const cached = await step.do('read cache', async () => this.env.CACHE.get(event.payload.id));
    const greeting = this.env.GREETING;
    this.ctx.waitUntil(Promise.resolve());
    return { cached, greeting };`),
    });
    const todos = m
      .report('workflows.ts')
      .functions[0].notes.filter((n) => n.severity === 'todo')
      .map((n) => n.message);
    expect(todos).toEqual([
      expect.stringContaining(
        '`this.env.CACHE` is a KV namespace binding, which exists only on Cloudflare'
      ),
      expect.stringContaining(
        '`this.env.GREETING` is a var. Workflow functions cannot read the environment'
      ),
      expect.stringContaining('`this.ctx` is the Worker execution context'),
    ]);
  });

  it('maps sleep() durations, including months and values only known at runtime', async () => {
    const m = await migrate({
      'workflows.ts': workflow(`    await step.sleep('a', '10 seconds');
    await step.sleep('b', '1 hour');
    await step.sleep('c', '2 months');
    await step.sleep('d', 1500);
    await step.sleep('e', event.payload.id as any);
    await step.sleepUntil('f', Date.now() + 1000);
    await step.sleepUntil('g', new Date('2030-01-01'));`),
    });
    const code = m.out('workflows.ts');
    expect(code).toContain("await sleep('10 seconds');");
    expect(code).toContain("await sleep('1 hour');");
    // `ms` has no months: Cloudflare's month is 30 days.
    expect(code).toContain("await sleep('60 days');");
    expect(code).toContain('await sleep(1500);');
    expect(code).toContain(
      'await sleep(cloudflareDuration(event.payload.id as any));'
    );
    expect(code).toContain('await sleep(new Date(Date.now() + 1000));');
    expect(code).toContain("await sleep(new Date('2030-01-01'));");
    expect(code).toContain(
      'function cloudflareDuration(duration: number | string): number {'
    );
  });

  it('reads waitForEvent() events from the run inbox, by type, with Cloudflare timeouts', async () => {
    const m = await migrate({
      'workflows.ts':
        workflow(`    const approval = await step.waitForEvent<{ by: string }>('approval', { type: 'approved', timeout: '2 hours' });
    const note = await step.waitForEvent('note', { type: 'note' });
    return { by: approval.payload.by, note: note.payload };`),
    });
    const code = m.out('workflows.ts');
    expect(code).toContain(
      'const events = workflowEvents(`MyWorkflow:${event.instanceId}`);'
    );
    expect(code).toContain(
      "const approval = await events.next<{ by: string }>('approved', 7200000);"
    );
    // Cloudflare's default timeout is 24 hours.
    expect(code).toContain("const note = await events.next('note', 86400000);");
    expect(code).toContain(
      'throw new Error(`WorkflowTimeoutError: Execution timed out after ${timeoutMs}ms`);'
    );
    expect(code).toContain("import { createHook, sleep } from 'workflow';");
    expect(
      m.report('workflows.ts').functions[0].hooks.map((h) => [h.name, h.token])
    ).toEqual([
      ['approved', '`MyWorkflow:${event.instanceId}`'],
      ['note', '`MyWorkflow:${event.instanceId}`'],
    ]);
    await expect(compiled(code)).resolves.toMatchObject({
      workflows: ['MyWorkflow'],
    });
  });

  it('turns NonRetryableError into FatalError', async () => {
    const m = await migrate({
      'workflows.ts': workflow(`    await step.do('check', async () => {
      if (!event.payload.id) throw new NonRetryableError('no id', 'ValidationError');
      throw new NonRetryableError('always');
    });`),
    });
    const code = m.out('workflows.ts');
    expect(code).toContain(
      "if (!event.payload.id) throw new FatalError('no id');"
    );
    expect(code).toContain("throw new FatalError('always');");
    expect(code).toContain("import { FatalError } from 'workflow';");
  });

  it('leaves rollback handlers, step timeouts and nested steps under a TODO', async () => {
    const m = await migrate({
      'workflows.ts':
        workflow(`    await step.do('charge', { timeout: '30 seconds' }, async () => 1, { rollback: async () => {} });
    await step.do('outer', async () => step.do('inner', async () => 2));
    let count = 0;
    await step.do('count', async () => { count++; });`),
    });
    const todos = m
      .report('workflows.ts')
      .functions[0].notes.filter((n) => n.severity === 'todo')
      .map((n) => n.message);
    expect(todos).toEqual([
      expect.stringContaining(
        "Cloudflare stopped each attempt of this step after `'30 seconds'`"
      ),
      expect.stringContaining('registers a rollback handler'),
      expect.stringContaining(
        'A step tool is called inside a `step.do()` callback'
      ),
      expect.stringContaining('The step assigns to `count`'),
    ]);
    const code = m.out('workflows.ts');
    expect(code).toContain("await step.do('outer'");
    expect(code).toContain("await step.do('count'");
  });

  it('does not migrate classes with other members', async () => {
    const m = await migrate({
      'workflows.ts': `${header}
export class Helper extends WorkflowEntrypoint {
  private label = 'x';
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    return step.do('a', async () => 1);
  }
}
`,
    });
    expect(m.report('workflows.ts').notes.map((n) => n.message)).toEqual([
      expect.stringContaining('has members other than `run()` (label)'),
    ]);
    expect(m.report('workflows.ts').functions).toEqual([]);
  });

  it('writes plain JavaScript for .js files', async () => {
    const m = await migrate({
      'workflows.js': `import { WorkflowEntrypoint } from 'cloudflare:workers';

export class Hello extends WorkflowEntrypoint {
  async run(event, step) {
    const name = await step.do('name', async () => event.payload.name);
    await step.sleep('nap', '1 second');
    const reply = await step.waitForEvent('reply', { type: 'reply', timeout: 1000 });
    return \`\${name}: \${reply.payload}\`;
  }
}
`,
    });
    const code = m.out('workflows.js');
    expect(code).toContain('export async function Hello(event) {');
    expect(code).toContain('async function nameStep(event) {');
    expect(code).not.toMatch(/: any|: string|@wf|<\{/);
    const file = join(m.dir, 'check.mjs');
    writeFileSync(file, code);
    expect(() =>
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    ).not.toThrow();
    await expect(compiled(code, 'workflows.js')).resolves.toEqual({
      workflows: ['Hello'],
      steps: ['nameStep'],
    });
  });

  it('reports the Worker code that used the bindings, and a drop-in adapter', async () => {
    const m = await migrate({
      'wrangler.json': wrangler,
      'workflows.ts': workflow("    return step.do('a', async () => 1);"),
      'worker.ts': `type Bindings = { MY_WORKFLOW: Workflow };
export default {
  async fetch(request: Request, env: Bindings) {
    const instance = await env.MY_WORKFLOW.create({ id: 'a', params: {} });
    await instance.sendEvent({ type: 'approved', payload: { ok: true } });
    const again = await env.MY_WORKFLOW.get('a');
    await instance.terminate();
    return Response.json(await instance.status());
  },
};
`,
    });
    expect(
      m.report('worker.ts').boundary.map((b) => [b.kind, b.names])
    ).toEqual([
      ['create', ['MY_WORKFLOW']],
      ['sendEvent', ['approved']],
      ['get', ['MY_WORKFLOW']],
      ['terminate', []],
      ['status', []],
    ]);
    expect(m.report('worker.ts').changed).toBe(false);
    const markdown = m.markdown();
    expect(markdown).toContain(
      "| `MY_WORKFLOW` | `MyWorkflow` | `MyWorkflow` in `workflows.ts` | `workflowInstances('MyWorkflow', MyWorkflow)` |"
    );
    expect(markdown).toContain('export function workflowInstances<P>(');
    expect(markdown).toContain(
      "Use the adapter's `sendEvent({ type, payload })`"
    );
  });

  it('flags a migrated file that still imports cloudflare modules', async () => {
    const m = await migrate({
      'workflows.ts': `import { WorkflowEntrypoint, WorkerEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
export class A extends WorkflowEntrypoint {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    return step.do('a', async () => 1);
  }
}
export class Api extends WorkerEntrypoint {}
`,
    });
    expect(m.report('workflows.ts').notes.map((n) => n.message)).toEqual([
      expect.stringContaining('still imports `cloudflare:workers`'),
    ]);
    expect(m.out('workflows.ts')).toContain(
      "import { WorkerEntrypoint } from 'cloudflare:workers';"
    );
  });

  it('produces the workflow committed in the vitest workbench', async () => {
    const fixtureDir = join(
      cliRoot,
      'tests',
      'fixture',
      'cloudflare-workflows'
    );
    const m = await migrate({
      'wrangler.jsonc': readFileSync(
        join(fixtureDir, 'wrangler.jsonc'),
        'utf8'
      ),
      'workflows.ts': readFileSync(join(fixtureDir, 'workflows.ts'), 'utf8'),
    });
    expect(m.failed).toEqual([]);
    expect(summarize(m.reports).todos).toBe(0);
    const committedPath = join(
      repoRoot,
      'workbench',
      'vitest',
      'workflows',
      'cloudflare-workflows-migrated.ts'
    );
    const output = m.out('workflows.ts');
    if (process.env.UPDATE_CLOUDFLARE_FIXTURE)
      writeFileSync(committedPath, output);
    // The committed copy is formatted with Biome; compare what formatting cannot change.
    const normalize = (code: string) =>
      code
        .replace(/\s+/g, '')
        .replace(/,([)\]}])/g, '$1')
        .replace(/;}/g, '}')
        .replace(/"/g, "'")
        // Biome starts a union broken over lines with \`|\`.
        .replace(/([:=<(,])\|/g, '$1');
    expect(normalize(readFileSync(committedPath, 'utf8'))).toBe(
      normalize(output)
    );
  });
});

describe('wrangler config', () => {
  it('reads workflows, vars and bindings from TOML', () => {
    const toml = parseToml(`name = "app" # the worker
main = "src/index.ts"

[vars]
GREETING = "hello"
FLAG = true

[[workflows]]
name = "orders"
binding = "ORDERS"
class_name = "OrderWorkflow"

[[kv_namespaces]]
binding = "CACHE"
id = "abc"

[[durable_objects.bindings]]
name = "ROOMS"
class_name = "Room"

[ai]
binding = "AI"
`);
    expect(toml).toMatchObject({
      vars: { GREETING: 'hello', FLAG: true },
      workflows: [
        { name: 'orders', binding: 'ORDERS', class_name: 'OrderWorkflow' },
      ],
      kv_namespaces: [{ binding: 'CACHE' }],
      durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'Room' }] },
      ai: { binding: 'AI' },
    });
    const dir = mkdtempSync(join(tmpdir(), 'wrangler-'));
    dirs.push(dir);
    writeFileSync(
      join(dir, 'wrangler.toml'),
      '[vars]\nA = "1"\n\n[[workflows]]\nbinding = "W"\nclass_name = "C"\n\n[[r2_buckets]]\nbinding = "FILES"\n'
    );
    const context = readWranglerConfig(dir);
    expect([...context.vars]).toEqual(['A']);
    expect(context.workflows).toEqual([
      { binding: 'W', className: 'C', name: undefined },
    ]);
    expect(context.bindings.get('FILES')).toBe('R2 bucket');
  });

  it('strips JSONC comments and trailing commas without touching strings', () => {
    expect(
      JSON.parse(
        stripJsonComments('{ // c\n "a": "http://x", /* b */ "b": [1,], }')
      )
    ).toEqual({ a: 'http://x', b: [1] });
  });
});
