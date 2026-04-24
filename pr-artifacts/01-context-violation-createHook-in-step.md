# 01 · Context violation — `createHook()` called inside a step

## Scenario

`workbench/example/workflows/1_simple.ts` patched to call `createHook()`
from inside the `add` step:

```ts
async function add(a: number, b: number): Promise<number> {
  'use step';
  createHook();          // ← workflow-only API called from step context
  return a + b;
}
```

Run via `POST /api/workflows/start { "workflowName": "simple", "args": [1] }`.

## What this PR changes

- **Single block, no retries.** Context-violation errors now set `fatal: true`
  and `FatalError.is(err)` recognizes them, so the step dies on attempt 1
  instead of burning through 3 retries and spamming 4 near-identical log
  blocks.
- **Step log renders the stack inline, not JSON-escaped.** The step-fatal
  framing + full stack trace go into the log *message* (matching the
  workflow-level framing), and the metadata object keeps only the
  structured indexable fields (`errorAttribution`, `errorName`,
  `errorMessage`, `hint`, IDs). Log drains still get clean structured
  fields; humans reading the terminal see a readable stack.
- **User-friendly names.** `step//./workflows/1_simple//add` renders as
  `add (./workflows/1_simple)` in the framing string — parsed by the
  existing `parseStepName` / `parseWorkflowName` utilities.
- **Plain text in `errorMessage` / `hint`.** Fields are free of
  `\x1B[...m` ANSI escape bytes — structured log drains and CBOR event
  payloads stay clean. The fancy framed rendering lives on
  `[util.inspect.custom]` / `toString()` only.
- **User-vs-SDK attribution.** `errorAttribution: 'user'` flags this as a
  user-caused fault (not an SDK bug), feeding into the future ownership UI.
- **Docs link.** `╰▶ docs: https://workflow-sdk.dev/docs/api-reference/workflow/create-hook`
  points the user at the exact API reference.

## Actual log output

```
Simple workflow started
 POST /.well-known/workflow/v1/flow 200 in 224ms (next.js: 128ms, application-code: 96ms)
[workflow-sdk] Step add (./workflows/1_simple) threw a FatalError — bubbling up to parent workflow
NotInWorkflowContextError: `createHook()` can only be called inside a workflow function
╰▶ docs: https://workflow-sdk.dev/docs/api-reference/workflow/create-hook
    at add (…workbench_0njdtf~._.js:13:164)
    … (full stack omitted for brevity) …
{
  workflowRunId: 'wrun_01KPYSYNXMEBS5R015DRXFKGMA',
  stepId: 'step_01KPYSYP298P9NZX4K6819C4QQ',
  stepName: 'step//./workflows/1_simple//add',
  errorAttribution: 'user',
  errorName: 'NotInWorkflowContextError',
  errorMessage: '`createHook()` can only be called inside a workflow function\n╰▶ docs: https://workflow-sdk.dev/docs/api-reference/workflow/create-hook',
  hint: 'A workflow-only or step-only API was called from the wrong context. The error message includes the exact API and how to move the call.'
}
 POST /.well-known/workflow/v1/step 200 in 167ms
[workflow-sdk] Workflow simple (./workflows/1_simple) threw
NotInWorkflowContextError: `createHook()` can only be called inside a workflow function
╰▶ docs: https://workflow-sdk.dev/docs/api-reference/workflow/create-hook
    at add (…)
    … (full stack omitted) …
{
  errorCode: 'USER_ERROR',
  errorAttribution: 'user',
  errorName: 'NotInWorkflowContextError',
  errorMessage: '`createHook()` can only be called inside a workflow function\n╰▶ docs: …',
  hint: 'A workflow-only or step-only API was called from the wrong context. …'
}
 POST /.well-known/workflow/v1/flow 200 in 89ms
```

Followed by the standard `WorkflowRunFailedError` thrown out of `start()` to
the caller, with the original context-violation error attached as `[cause]`
(same plain text, no ANSI).

## Compare: pre-PR

Before this PR the same scenario emitted:

1. Four near-identical log blocks (1 original + 3 retries) — context
   violations weren't recognized as fatal, so the step was retried up to
   max attempts even though it was guaranteed to fail again.
2. The step-fatal log embedded the full stack trace inside an `errorStack`
   string field — util.inspect rendered it as an escape-sequence-heavy
   JSON blob inside the log object. Now the stack sits on the message
   (rendered inline by the terminal) and the fields stay compact.
3. `errorMessage` / `errorStack` contained literal `\x1B[31m...\x1B[0m`
   ANSI escape bytes, making structured log drains unreadable.
4. No `errorAttribution` field.
5. No `hint` field / docs link.

## Related changesets

- `.changeset/context-errors-plain-message.md` — plain `.message` / `.stack`, lazy pretty inspect
- `.changeset/context-errors-fatal.md` — `FatalError.is()` widening
- `.changeset/friendlier-error-attribution.md` — `errorAttribution` field
- `.changeset/friendlier-logger-metadata.md` — `[workflow-sdk]` prefix, scoped logger
- `.changeset/log-readability.md` — inline stack + friendly names in step-level logs
