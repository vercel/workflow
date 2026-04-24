# 04 · Error attribution — `FatalError` thrown by user code

## Scenario

User throws an explicit `FatalError` from a step — the canonical "stop
retrying, this will never succeed" signal. The PR ensures the resulting
log clearly attributes ownership to **user** (not SDK).

```ts
async function add(a: number, b: number): Promise<number> {
  'use step';
  throw new FatalError('This step cannot possibly succeed: bad inputs');
}
```

## Actual log output

Single failure block (no retry loop); framing + stack inline:

```
Simple workflow started
 POST /.well-known/workflow/v1/flow 200 in 192ms
[workflow-sdk] Step add (./workflows/1_simple) threw a FatalError — bubbling up to parent workflow
FatalError: This step cannot possibly succeed: bad inputs
    at add (…workbench_0njdtf~._.js:3274:11)
    … (full stack omitted) …
{
  workflowRunId: 'wrun_01KPYT5259R2WBNCSM5AKHV28K',
  stepId:        'step_01KPYT52BT92SAJ57Q2BPJ3AFT',
  stepName:      'step//./workflows/1_simple//add',
  errorAttribution: 'user',
  errorName:   'FatalError',
  errorMessage: 'This step cannot possibly succeed: bad inputs'
}
 POST /.well-known/workflow/v1/step 200 in 230ms
[workflow-sdk] Workflow simple (./workflows/1_simple) threw
FatalError: This step cannot possibly succeed: bad inputs
    at add (…)
    … (full stack omitted) …
{
  errorCode: 'USER_ERROR',
  errorAttribution: 'user',
  errorName: 'FatalError',
  errorMessage: 'This step cannot possibly succeed: bad inputs'
}
 POST /.well-known/workflow/v1/flow 200 in 78ms
```

## What this PR ensures

- **`errorAttribution: 'user'`** on both the step-level and workflow-level
  failure logs — downstream triage UI can separate user-code faults from
  SDK-internal faults.
- **`errorCode: 'USER_ERROR'`** on the workflow-level log.
- **`[workflow-sdk]` prefix** on both log lines so SDK-emitted output is
  grepable.
- **Short-circuit on attempt 1** — `FatalError.is(err)` matches a user
  `FatalError` directly, so the queue retry loop does not fire.
- **Pretty step-level rendering** — `Step add (./workflows/1_simple) threw
  a FatalError` (not `Step "step//./workflows/1_simple//add" threw`), with
  the stack on the message so `console.error` prints it natively.

## Related changesets

- `.changeset/friendlier-error-attribution.md` — `errorAttribution` field
- `.changeset/friendlier-logger-metadata.md` — `[workflow-sdk]` prefix
- `.changeset/log-readability.md` — inline stack + friendly names
