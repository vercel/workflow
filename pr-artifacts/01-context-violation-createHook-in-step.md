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

- **Single block, no retries.** Context-violation errors set `fatal: true`
  and `FatalError.is(err)` recognizes them, so the step dies on attempt 1
  instead of burning through 3 retries and spamming 4 near-identical log
  blocks.
- **Pretty structured-log block (no JSON dump).** The runtime logger now
  composes `[workflow-sdk] <message>` + the stack + an opinionated
  metadata block — *one string passed to `console.error`* — instead of
  letting `util.inspect` quote-escape multi-line stacks and paragraph
  hints inside an object dump.
- **Friendly names + raw IDs side-by-side.** Step / workflow IDs render
  as `wrun_…` and `step_…` ULIDs (copy/paste-able for the inspect CLI)
  alongside the parsed friendly name (`add (./workflows/1_simple)`).
- **Color-coded attribution.** `user error` red / `sdk error` magenta
  badge, paired with the error class in bold.
- **Hint as a paragraph, not a JSON string.** Multi-line hints render
  cleanly under `hint:` instead of being backslash-quote-escaped.
- **Plain text in the runtime layer.** No ANSI escape bytes leak into
  `errorMessage` / `errorStack` / `hint` fields; ANSI is applied in the
  log formatter only, and only when the terminal supports it.

## Actual log output

```
Simple workflow started
 POST /.well-known/workflow/v1/flow 200 in 209ms (next.js: 118ms, application-code: 91ms)
[workflow-sdk] Step add (./workflows/1_simple) threw a FatalError — bubbling up to parent workflow
NotInWorkflowContextError: `createHook()` can only be called inside a workflow function
╰▶ docs: https://workflow-sdk.dev/docs/api-reference/workflow/create-hook
    at add (…workbench_0njdtf~._.js:12:164)
    … (full stack omitted for brevity) …
  user error · NotInWorkflowContextError
  run    wrun_01KQE8WAC5GR090TXYZEQV84ZN
  step   step_01KQE8WAGDPMQYWTVNSRG6VA3Q · add (./workflows/1_simple)
  hint: A workflow-only or step-only API was called from the wrong context. The error message includes the exact API and how to move the call.
 POST /.well-known/workflow/v1/step 200 in 156ms

[workflow-sdk] Workflow simple (./workflows/1_simple) threw
NotInWorkflowContextError: `createHook()` can only be called inside a workflow function
╰▶ docs: https://workflow-sdk.dev/docs/api-reference/workflow/create-hook
    at add (…)
    … (full stack omitted) …
  user error · FatalError
  run    wrun_01KQE8WAC5GR090TXYZEQV84ZN · simple (./workflows/1_simple)
  code   USER_ERROR
 POST /.well-known/workflow/v1/flow 200 in 77ms
```

(In a TTY, `user error` is red and the error class is bold; the keys
`run`, `step`, `code`, `hint` are dimmed; `·` separators are dimmed.
Snapshots above are stripped to plain text since GitHub markdown
doesn't render ANSI.)

Followed by the standard `WorkflowRunFailedError` thrown out of `start()` to
the caller, with the original context-violation error attached as `[cause]`.

## Compare: pre-PR

Before this PR the same scenario emitted:

1. **Four** near-identical log blocks (1 original + 3 retries) — context
   violations weren't recognized as fatal, so the step was retried up to
   max attempts even though it was guaranteed to fail again.
2. The metadata was a `util.inspect`-rendered object dump:
   `{ workflowRunId: '…', stepName: '…', errorAttribution: 'user',
   errorName: 'NotInWorkflowContextError', errorMessage: '`createHook()`
   can only be called inside a workflow function\n╰▶ docs: …',
   errorStack: 'NotInWorkflowContextError: …\n    at add (…)\n   …',
   hint: 'A workflow-only or step-only API was called from the wrong
   context. …' }` — multi-line stack and hint strings were
   backslash-`\n`-escaped on a single line each, IDs got no parsing.
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
- `.changeset/pretty-log-format.md` — opinionated formatter for structured metadata
