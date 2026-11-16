import type { FileReport } from '../report-types.js';
import { plural, summarize } from '../summary.js';
import type { CloudflareContext } from './transform.js';

/**
 * Stand-in for a Cloudflare Workflow binding (`env.MY_WORKFLOW`) on top of
 * Workflow SDK runs, so the code that created instances and sent them events
 * changes little. The migrated workflow reads its events from the run's
 * start Hook, whose token is `${name}:${id}`.
 */
export const INSTANCES_ADAPTER = `import { getHookByToken, getRun, resumeHook, start } from 'workflow/api';
import { HookConflictError } from 'workflow/errors';

type WorkflowEvent<P> = { payload: P; timestamp: Date; instanceId: string; workflowName: string };

/** Creates and finds runs the way a Cloudflare Workflow binding creates and finds instances. */
export function workflowInstances<P>(
  name: string,
  workflow: (event: WorkflowEvent<P>) => Promise<unknown>
) {
  const token = (id: string) => \`\${name}:\${id}\`;
  const run = async (id: string) => getRun((await getHookByToken(token(id))).runId);
  const instance = (id: string) => ({
    id,
    async status() {
      const handle = await run(id);
      const status = await handle.status;
      if (status === 'completed') return { status: 'complete', output: await handle.returnValue };
      if (status === 'cancelled') return { status: 'terminated' };
      if (status === 'failed') {
        let error = await handle.returnValue.then(() => undefined, (e: any) => e?.cause ?? e);
        // A step that ran out of retries fails the run with a FatalError whose
        // cause is what the step threw: Cloudflare reports the latter.
        if (error?.name === 'FatalError' && error.cause) error = error.cause;
        return { status: 'errored', error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) } };
      }
      return { status: status === 'pending' ? 'queued' : 'running' };
    },
    async sendEvent({ type, payload }: { type: string; payload: unknown }) {
      await resumeHook(token(id), { type, payload, timestamp: new Date() });
    },
    async terminate() {
      await (await run(id)).cancel();
    },
  });
  return {
    async create({ id = crypto.randomUUID(), params }: { id?: string; params?: P } = {}) {
      try {
        await start(workflow, [{ payload: params as P, timestamp: new Date(), instanceId: id, workflowName: name }], {
          // One run per ID, kept for 30 days after it ends, like an instance ID.
          experimental_hook: { token: token(id), experimental_minRetention: '30 days' },
        });
      } catch (error) {
        if (HookConflictError.is(error)) throw new Error(\`An instance with ID \${id} already exists\`);
        throw error;
      }
      return instance(id);
    },
    async get(id: string) {
      await getHookByToken(token(id)); // throws when there is no such instance
      return instance(id);
    },
  };
}`;

export function renderMarkdown(
  reports: FileReport[],
  failed: Array<{ file: string; error: string }>,
  context?: CloudflareContext
): string {
  const summary = summarize(reports);
  const out: string[] = [];
  out.push('# Cloudflare Workflows to Workflow SDK migration report', '');
  out.push(
    `${plural(summary.filesChanged, 'file')} changed: ${plural(summary.functions, 'workflow')} migrated, ${plural(summary.steps, 'step')} lifted into "use step" functions, ${plural(summary.hooks, 'event wait')} migrated, ${plural(summary.todos, 'TODO')}.`,
    ''
  );
  out.push(
    'Every place that needs a decision is marked `TODO(workflow-migrate)` in the code. Search for it to work through the list below.',
    ''
  );
  if (failed.length) {
    out.push('## Files not written', '');
    for (const { file, error } of failed) out.push(`- \`${file}\`: ${error}`);
    out.push('');
  }

  const byClass = new Map<string, { workflow: string; file: string }>();
  for (const report of reports) {
    for (const fn of report.functions) {
      if (fn.sourceId)
        byClass.set(fn.sourceId, {
          workflow: fn.workflowName,
          file: report.file,
        });
    }
  }
  if (context?.workflows.length) {
    out.push(
      `## Workflow bindings in \`${context.configFile ?? 'wrangler config'}\``,
      ''
    );
    out.push(
      '| Binding | Class | Workflow function | Replace `env.<binding>` with |',
      '| --- | --- | --- | --- |'
    );
    for (const w of context.workflows) {
      const target = byClass.get(w.className);
      out.push(
        `| \`${w.binding}\` | \`${w.className}\` | ${target ? `\`${target.workflow}\` in \`${target.file}\`` : 'not migrated'} | ${target ? `\`workflowInstances('${target.workflow}', ${target.workflow})\`` : '-'} |`
      );
    }
    out.push('');
  }

  for (const report of reports) {
    if (!report.functions.length && !report.notes.length) continue;
    out.push(`## \`${report.file}\``, '');
    for (const note of report.notes) {
      out.push(
        `- ${note.severity === 'todo' ? '**TODO** ' : ''}line ${note.line}: ${note.message}`
      );
    }
    if (report.notes.length) out.push('');
    for (const fn of report.functions) {
      out.push(
        `### \`${fn.workflowName}\`${fn.sourceId && fn.sourceId !== fn.workflowName ? ` (class \`${fn.sourceId}\`)` : ''}`,
        ''
      );
      if (fn.steps.length) {
        out.push(
          '| Cloudflare step | Step function | Captured variables, now arguments |',
          '| --- | --- | --- |'
        );
        for (const step of fn.steps) {
          const captured = step.captured.length
            ? step.captured
                .map((c) => `\`${c.name}\` (line ${c.declaredAt})`)
                .join(', ')
            : 'none';
          out.push(
            `| ${code(step.stepId.replace(/\|/g, '\\|'))} (line ${step.line}) | \`${step.functionName}\` | ${captured} |`
          );
        }
        out.push('');
      }
      for (const hook of fn.hooks) {
        out.push(
          `- line ${hook.line}: \`step.waitForEvent({ type: ${hook.name} })\` now reads the run's events, whose token is ${code(hook.token)}.`
        );
      }
      if (fn.hooks.length) out.push('');
      for (const note of fn.notes.filter((n) => n.severity === 'todo'))
        out.push(`- **TODO** line ${note.line}: ${note.message}`);
      for (const note of fn.notes.filter((n) => n.severity === 'info'))
        out.push(`- line ${note.line}: ${note.message}`);
      if (fn.notes.length) out.push('');
    }
  }

  const boundary = reports.flatMap((r) =>
    r.boundary.map((b) => ({ ...b, file: r.file }))
  );
  if (boundary.length) {
    out.push('## Where your app used Workflow bindings', '');
    out.push(
      'These calls were left unchanged. Replace each one as suggested:',
      ''
    );
    for (const call of boundary) {
      out.push(`- \`${call.file}:${call.line}\` \`${call.text}\``);
      out.push(`  - ${suggest(call.kind, call.names)}`);
    }
    out.push('');
  }

  out.push('## Replace the Workflow bindings', '');
  out.push(
    'The migrated workflow takes `{ payload, timestamp, instanceId, workflowName }`, as `run(event)` did, and reads the events sent to it from its start Hook. This adapter keeps the binding API your app already calls: `create({ id, params })`, `get(id)`, and `status()`, `sendEvent()` and `terminate()` on an instance. Put it in your app and replace `env.<binding>` with `workflowInstances(name, workflow)`, using the names in the table above:',
    ''
  );
  out.push('```ts', INSTANCES_ADAPTER, '```', '');
  out.push(
    'There is no `pause()`, `resume()` or `restart()`: cancel the run and start a new one where you need to.',
    ''
  );
  out.push('## Next steps', '');
  out.push(
    '1. Add the Workflow SDK to your framework if you have not yet. See https://workflow-sdk.dev/docs/getting-started.',
    '2. Resolve every `TODO(workflow-migrate)` comment, starting with the bindings (`this.env.*`) the steps used.',
    '3. Replace the binding calls listed above, then remove the `[[workflows]]` entries and the Worker once nothing uses them.',
    '4. Check that every captured variable listed above is serializable (plain data, Date, Map, Set, URL, and other types listed at https://workflow-sdk.dev/docs/foundations/serialization).',
    ''
  );
  return out.join('\n');
}

function suggest(kind: string, names: string[]): string {
  const binding = names[0] ? `\`${names[0]}\`` : 'the binding';
  switch (kind) {
    case 'create':
      return `Create the run with the adapter's \`create({ id, params })\`, or \`start(workflow, [{ payload: params, timestamp: new Date(), instanceId: id, workflowName }], { experimental_hook: { token: \`\${workflowName}:\${id}\` } })\` from \`workflow/api\` (${binding}).`;
    case 'createBatch':
      return `Call the adapter's \`create()\` once per instance; there is no batch call (${binding}).`;
    case 'get':
      return `Use the adapter's \`get(id)\`, which finds the run through \`getHookByToken()\` (${binding}).`;
    case 'sendEvent':
      return `Use the adapter's \`sendEvent({ type, payload })\`, or \`resumeHook(\`\${workflowName}:\${id}\`, { type, payload, timestamp: new Date() })\` from \`workflow/api\`${names[0] ? ` (event type ${code(names[0])})` : ''}.`;
    case 'status':
      return "Use the adapter's `status()`, which maps the run status to `queued`, `running`, `complete`, `errored` or `terminated`.";
    case 'terminate':
      return "Use the adapter's `terminate()`, which cancels the run.";
    case 'pause':
    case 'resume':
      return 'No equivalent: the Workflow SDK cannot pause a run. Cancel it and start a new one, or have the workflow wait on a hook.';
    case 'restart':
      return 'No in-place restart: cancel the run and start a new one (with a new ID, or after the old run releases its token).';
    default:
      return 'Replace this call.';
  }
}

function code(text: string): string {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length)
  );
  const fence = '`'.repeat(longest + 1);
  const pad = longest ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
