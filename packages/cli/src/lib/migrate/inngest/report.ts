import type { FileReport, MigratedFunction } from './report-types.js';

export interface ReportSummary {
  filesChanged: number;
  functions: number;
  steps: number;
  hooks: number;
  todos: number;
}

export function summarize(reports: FileReport[]): ReportSummary {
  const summary: ReportSummary = {
    filesChanged: 0,
    functions: 0,
    steps: 0,
    hooks: 0,
    todos: 0,
  };
  for (const report of reports) {
    if (report.changed) summary.filesChanged++;
    summary.functions += report.functions.length;
    summary.todos += report.notes.filter((n) => n.severity === 'todo').length;
    for (const fn of report.functions) {
      summary.steps += fn.steps.length;
      summary.hooks += fn.hooks.length;
      summary.todos += fn.notes.filter((n) => n.severity === 'todo').length;
    }
  }
  return summary;
}

interface WorkflowRef {
  fn: MigratedFunction;
  file: string;
}

/** Which migrated workflows each Inngest event name started or resumed. */
function eventIndex(reports: FileReport[]) {
  const triggers = new Map<string, WorkflowRef[]>();
  const waits = new Map<string, Array<WorkflowRef & { token: string }>>();
  for (const report of reports) {
    for (const fn of report.functions) {
      for (const trigger of fn.triggers) {
        if (trigger.kind !== 'event') continue;
        const list = triggers.get(trigger.value) ?? [];
        list.push({ fn, file: report.file });
        triggers.set(trigger.value, list);
      }
      for (const hook of fn.hooks) {
        const list = waits.get(hook.name) ?? [];
        list.push({
          fn,
          file: report.file,
          token: hook.resumeToken ?? hook.token,
        });
        waits.set(hook.name, list);
      }
    }
  }
  return { triggers, waits };
}

/** Markdown report: what moved where, what was captured, what is left. */
export function renderMarkdown(
  reports: FileReport[],
  failed: Array<{ file: string; error: string }> = []
): string {
  const summary = summarize(reports);
  const { triggers, waits } = eventIndex(reports);
  const out: string[] = [];
  out.push('# Inngest to Workflow SDK migration report', '');
  out.push(
    `${plural(summary.filesChanged, 'file')} changed: ${plural(summary.functions, 'function')} migrated to workflows, ${plural(summary.steps, 'step')} lifted into "use step" functions, ${plural(summary.hooks, 'wait')} migrated to hooks, ${plural(summary.todos, 'TODO')}.`,
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
        `### \`${fn.workflowName}\`${fn.inngestId ? ` (Inngest function \`${fn.inngestId}\`)` : ''}`,
        ''
      );
      if (fn.triggers.length) {
        out.push(
          `Triggered by ${fn.triggers.map((t) => (t.kind === 'event' ? `event \`${t.value}\`` : t.kind === 'cron' ? `cron \`${t.value}\`` : `\`${t.value}\``)).join(', ')}.`,
          ''
        );
      }
      if (fn.steps.length) {
        out.push(
          '| Inngest step | Step function | Captured variables, now arguments |',
          '| --- | --- | --- |'
        );
        for (const step of fn.steps) {
          const captured = step.captured.length
            ? step.captured
                .map((c) => `\`${c.name}\` (line ${c.declaredAt})`)
                .join(', ')
            : 'none';
          const inputs = step.inputs
            ? `, plus ${step.inputs} input${step.inputs === 1 ? '' : 's'}`
            : '';
          out.push(
            `| ${code(escapeCell(step.stepId))} (line ${step.line}) | \`${step.functionName}\` | ${captured}${inputs} |`
          );
        }
        out.push('');
      }
      for (const hook of fn.hooks) {
        out.push(
          `- line ${hook.line}: \`${hook.source}("${hook.name}")\` is now a hook with token ${code(hook.token)}.`
        );
      }
      if (fn.hooks.length) out.push('');
      const todos = fn.notes.filter((n) => n.severity === 'todo');
      const infos = fn.notes.filter((n) => n.severity === 'info');
      for (const note of todos)
        out.push(`- **TODO** line ${note.line}: ${note.message}`);
      for (const note of infos)
        out.push(`- line ${note.line}: ${note.message}`);
      if (fn.notes.length) out.push('');
    }
  }

  const boundary = reports.flatMap((r) =>
    r.boundary.map((b) => ({ ...b, file: r.file }))
  );
  if (boundary.length) {
    out.push('## Where Inngest was called from your app', '');
    out.push(
      'These calls were left unchanged. Replace each one as suggested:',
      ''
    );
    for (const call of boundary) {
      out.push(`- \`${call.file}:${call.line}\` \`${call.text}\``);
      for (const suggestion of suggest(call, triggers, waits))
        out.push(`  - ${suggestion}`);
    }
    out.push('');
  }

  out.push('## Next steps', '');
  out.push(
    '1. Add the Workflow SDK to your framework if you have not yet (for Next.js, wrap `next.config` with `withWorkflow()`). See https://workflow-sdk.dev/docs/getting-started.',
    '2. Resolve every `TODO(workflow-migrate)` comment.',
    '3. Replace the calls listed under "Where Inngest was called from your app".',
    '4. Delete the Inngest `serve()` route and client once nothing imports them, then remove the `inngest` dependency.',
    '5. Check that every captured variable listed above is serializable (plain data, Date, Map, Set, URL, and other types listed at https://workflow-sdk.dev/docs/foundations/serialization). Functions and class instances without custom serialization cannot be step arguments.',
    ''
  );
  return out.join('\n');
}

function suggest(
  call: FileReport['boundary'][number],
  triggers: Map<string, WorkflowRef[]>,
  waits: Map<string, Array<WorkflowRef & { token: string }>>
): string[] {
  if (call.kind === 'serve') {
    return [
      'Delete this route: the Workflow SDK framework integration serves its own endpoints.',
    ];
  }
  if (call.kind === 'sendSignal') {
    return [
      `Use \`resumeHook(signal, { signal, data })\` from \`workflow/api\`${call.names.length ? ` (signal \`${call.names[0]}\`)` : ''}.`,
    ];
  }
  const out: string[] = [];
  for (const name of call.names) {
    for (const ref of triggers.get(name) ?? []) {
      const idempotency = ref.fn.config.idempotency ?? ref.fn.config.singleton;
      out.push(
        `\`${name}\` started \`${ref.fn.workflowName}\`: call \`start(${ref.fn.workflowName}, [{ name: '${name}', data }])\` from \`workflow/api\`, importing \`${ref.fn.workflowName}\` from \`${ref.file}\`${idempotency ? `, and pass \`{ experimental_hook: { token } }\` built from ${idempotency} so duplicates are refused` : ''}.`
      );
    }
    for (const ref of waits.get(name) ?? []) {
      out.push(
        `\`${name}\` resumed a waiting \`${ref.fn.workflowName}\` run: call \`resumeHook(token, event)\` from \`workflow/api\`, where \`event\` is the object you sent and the token is ${code(ref.token)}.`
      );
    }
    if (!triggers.has(name) && !waits.has(name)) {
      out.push(
        `No migrated function listens for \`${name}\`; remove the call or start the right workflow.`
      );
    }
  }
  if (!call.names.length)
    out.push(
      'The event name is not a literal; start the workflow it targeted with `start()`.'
    );
  return out;
}

/** Inline code that may itself contain backticks. */
function code(text: string): string {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length)
  );
  const fence = '`'.repeat(longest + 1);
  const pad = longest ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}
