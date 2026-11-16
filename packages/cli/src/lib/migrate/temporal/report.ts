import type { FileReport } from '../report-types.js';
import { plural, summarize } from '../summary.js';

/** Inline code that may itself contain backticks. */
function code(text: string): string {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((r) => r.length)
  );
  const fence = '`'.repeat(longest + 1);
  const pad = longest ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

const BOUNDARY: Record<string, string> = {
  start:
    'Call `start(workflow, args, { experimental_hook: { token: workflowId } })` from `workflow/api`. The start token keeps a workflow ID to one run at a time, as Temporal did; keep the returned `run.runId` (or look it up later with `(await getHookByToken(workflowId)).runId`).',
  execute:
    'Call `start(workflow, args, { experimental_hook: { token: workflowId } })` and `await run.returnValue`.',
  signalWithStart:
    'Start with `start(workflow, args, { experimental_hook: { token: workflowId } })`; on `HookConflictError`, the run already exists: resume its signal hook with `resumeHook(`${runId}:${signalName}`, args)`.',
  getHandle:
    'A handle by workflow ID: `(await getHookByToken(workflowId)).runId` gives the run, and `getRun(runId)` its status, `returnValue` and `cancel()`.',
  signal:
    "Call `resumeHook(`${runId}:${signal.name}`, args)` from `workflow/api`, where `args` is the signal's arguments array. Retry on `HookNotFoundError` for the first moments after `start()`, before the run has created its hooks.",
  query:
    'Queries have no equivalent: read the state the workflow publishes to a stream (`run.getReadable()`) or its run attributes.',
  executeUpdate:
    'Updates have no equivalent: resume a hook with the input, and read the result from a stream or a second hook.',
  startUpdate:
    'Updates have no equivalent: resume a hook with the input, and read the result from a stream or a second hook.',
  worker:
    'Delete the worker: the Workflow SDK framework integration runs workflows and steps inside your app.',
};

export function renderMarkdown(
  reports: FileReport[],
  failed: Array<{ file: string; error: string }> = []
): string {
  const summary = summarize(reports);
  const out: string[] = [];
  out.push('# Temporal to Workflow SDK migration report', '');
  out.push(
    `${plural(summary.filesChanged, 'file')} changed: ${plural(summary.functions, 'workflow')} migrated, ${plural(summary.steps, 'activity')} made into "use step" functions, ${plural(summary.hooks, 'signal')} migrated to hooks, ${plural(summary.todos, 'TODO')}.`
      .replace('1 activitys', '1 activity')
      .replace(/(\d+) activitys/, '$1 activities'),
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

  const signals: Array<{ workflow: string; name: string; token: string }> = [];
  for (const report of reports) {
    if (
      !report.functions.length &&
      !report.notes.length &&
      !report.steps?.length
    )
      continue;
    out.push(`## \`${report.file}\``, '');
    if (report.steps?.length) {
      out.push('Activities made into steps:', '');
      for (const step of report.steps)
        out.push(`- \`${step.functionName}\` (line ${step.line})`);
      out.push('');
    }
    for (const note of report.notes) {
      out.push(
        `- ${note.severity === 'todo' ? '**TODO** ' : ''}line ${note.line}: ${note.message}`
      );
    }
    if (report.notes.length) out.push('');
    if (report.functions.length) {
      out.push(
        `Workflows: ${report.functions.map((f) => `\`${f.workflowName}\``).join(', ')}.`,
        ''
      );
    }
    for (const fn of report.functions) {
      for (const hook of fn.hooks) {
        signals.push({
          workflow: fn.workflowName,
          name: hook.name,
          token: hook.resumeToken ?? hook.token,
        });
      }
      if (!fn.hooks.length && !fn.notes.length) continue;
      out.push(`### \`${fn.workflowName}\``, '');
      for (const hook of fn.hooks) {
        out.push(
          `- line ${hook.line}: signal \`${hook.name}\` is now a hook with token ${code(hook.token)}.`
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

  if (signals.length) {
    out.push('## Signal routing', '');
    out.push(
      "Where your app sent a signal, resume the run's hook instead. `run` is the run `start()` returned, or `getRun((await getHookByToken(workflowId)).runId)` when you only kept the workflow ID. The payload is the signal's arguments array.",
      ''
    );
    out.push('| Workflow | Signal | Resume |', '| --- | --- | --- |');
    for (const s of signals) {
      out.push(
        `| \`${s.workflow}\` | \`${s.name}\` | \`resumeHook(token, args)\` with ${code(s.token)} |`
      );
    }
    out.push('');
  }

  const boundary = reports.flatMap((r) =>
    r.boundary.map((b) => ({ ...b, file: r.file }))
  );
  if (boundary.length) {
    out.push('## Where Temporal was called from your app', '');
    out.push(
      'These calls were left unchanged. Replace each one as suggested:',
      ''
    );
    for (const call of boundary) {
      out.push(
        `- \`${call.file}:${call.line}\` \`${call.text.replace(/`/g, "'")}\``
      );
      out.push(
        `  - ${BOUNDARY[call.kind] ?? 'Replace this Temporal client call.'}`
      );
    }
    out.push('');
  }

  out.push('## Next steps', '');
  out.push(
    '1. Add the Workflow SDK to your framework if you have not yet (for Next.js, wrap `next.config` with `withWorkflow()`). See https://workflow-sdk.dev/docs/getting-started.',
    '2. Resolve every `TODO(workflow-migrate)` comment.',
    '3. Replace the calls listed under "Where Temporal was called from your app", using the Signal routing table for signals.',
    '4. Delete the worker, then remove the `@temporalio/*` dependencies once nothing imports them.',
    '5. Check that every activity argument and result is serializable (plain data, Date, Map, Set, URL, and the other types at https://workflow-sdk.dev/docs/foundations/serialization).',
    ''
  );
  return out.join('\n');
}
