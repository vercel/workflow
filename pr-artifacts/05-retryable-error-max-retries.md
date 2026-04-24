# 05 · Retryable (non-fatal) error — exhausts max retries

## Scenario

A step throws a plain `Error` (not `FatalError`) on every attempt. The
runtime should retry, eventually hit max deliveries, then surface a
single "hit max retries" log + the workflow-level failure.

```ts
async function add(a: number, b: number): Promise<number> {
  'use step';
  throw new Error('Transient failure, always fails');
}
```

## Actual log output

```
Simple workflow started
 POST /.well-known/workflow/v1/flow 200 in ~70ms
 POST /.well-known/workflow/v1/step 200 in 70ms        ← attempt 1
 POST /.well-known/workflow/v1/step 200 in 68ms        ← attempt 2
 POST /.well-known/workflow/v1/step 200 in 67ms        ← attempt 3
[workflow-sdk] Step add (./workflows/1_simple) hit max retries — bubbling error thrown by your step to the parent workflow
Error: Transient failure, always fails
    at add (…workbench_0njdtf~._.js:3271:11)
    … (full stack omitted) …
{
  workflowRunId: 'wrun_01KPYT7QKCN84S4BH0W3MCXWY5',
  workflowName:  'workflow//./workflows/1_simple//simple',
  stepId:        'step_01KPYT7QM2J4KNFVPHQKFRR3Y0',
  stepName:      'step//./workflows/1_simple//add',
  attempt: 4,
  retryCount: 3,
  errorAttribution: 'user',
  errorName:   'Error',
  errorMessage: 'Transient failure, always fails'
}
 POST /.well-known/workflow/v1/step 200 in 65ms
[workflow-sdk] Workflow simple (./workflows/1_simple) threw
Error: Transient failure, always fails
    at add (…)
    … (full stack omitted) …
{
  errorCode: 'USER_ERROR',
  errorAttribution: 'user',
  errorName: 'FatalError',
  errorMessage: 'Step "step//./workflows/1_simple//add" failed after 3 retries: Transient failure, always fails'
}
 POST /.well-known/workflow/v1/flow 200 in ~70ms
```

## What this PR ensures

- **One `hit max retries` summary log**, not 4 near-identical attempt
  logs — per-attempt step-failed emission stays quiet for retryable
  transient errors until the budget is exhausted.
- **Pretty step-level rendering** — `Step add (./workflows/1_simple) hit
  max retries` and the stack renders inline in the message.
- **`attempt: 4, retryCount: 3`** clearly distinguishes the total call
  count from the retry count.
- **`errorAttribution: 'user'`** on both summary logs.
- **`[workflow-sdk]` prefix** on SDK-emitted lines.
- **Scoped logger context** — `workflowRunId` / `stepId` / `stepName` are
  attached via `runtimeLogger.forRun(…).child({ stepId, stepName })` so
  every log in this unit of work carries consistent metadata.

## Related changesets

- `.changeset/friendlier-logger-metadata.md` — scoped logger + prefix + structured fields
- `.changeset/friendlier-error-attribution.md` — `errorAttribution`
- `.changeset/log-readability.md` — inline stack + friendly names
