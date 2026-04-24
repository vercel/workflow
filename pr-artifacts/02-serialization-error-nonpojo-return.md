# 02 · SerializationError — step returns a non-POJO

## Scenario

`workbench/example/workflows/1_simple.ts` patched so the `add` step returns
a class instance with methods (which `devalue` rejects):

```ts
class NotSerializable {
  method() { return 42; }
}

async function add(a: number, b: number): Promise<number> {
  'use step';
  return new NotSerializable() as unknown as number;
}
```

## What this PR changes

- **Friendly hint baked into the error message.** The error body now reads:

  > `Failed to serialize step return value`
  >
  > `Ensure you're returning serializable types (plain objects, arrays, primitives, Date, RegExp, Map, Set).`
  >
  > `Learn more: https://workflow-sdk.dev/err/serialization-failed`

- **Single block, no retries.** `SerializationError` is now marked
  `fatal = true`, *and* the dehydration call that produces it has been
  moved inside the step-handler's user-code try/catch. The error now
  routes through `userCodeFailed` → `step_failed`, so `FatalError.is()`
  short-circuits the retry loop on attempt 1.
- **Pretty step-level log** — framing + stack rendered inline, structured
  fields compact (same as Scenario 01).
- **`[workflow-sdk]` log prefix** on every SDK-emitted line.
- **Structured `context` / `problematicValue`** on the per-attempt
  "Serialization failed" log.

## Actual log output

```
Simple workflow started
 POST /.well-known/workflow/v1/flow 200 in 277ms (next.js: 185ms, application-code: 92ms)
[workflow-sdk] Serialization failed { context: 'step return value', problematicValue: NotSerializable {} }
[workflow-sdk] Step add (./workflows/1_simple) threw a FatalError — bubbling up to parent workflow
Error: Failed to serialize step return value
Ensure you're returning serializable types (plain objects, arrays, primitives, Date, RegExp, Map, Set).
Learn more: https://workflow-sdk.dev/err/serialization-failed
    at dehydrateStepReturnValue (…packages_0p_d9mh._.js:9734:15)
    … (full stack omitted) …
{
  workflowRunId: 'wrun_01KPYT…',
  stepId:        'step_01KPYT…',
  stepName:      'step//./workflows/1_simple//add',
  errorAttribution: 'user',
  errorName:   'SerializationError',
  errorMessage: "Failed to serialize step return value\n\nEnsure you're returning serializable types…\n\nLearn more: https://workflow-sdk.dev/err/serialization-failed",
  hint: 'A value passed across a workflow/step boundary could not be serialized. …'
}
 POST /.well-known/workflow/v1/step 200 in ~200ms
[workflow-sdk] Workflow simple (./workflows/1_simple) threw
SerializationError: Failed to serialize step return value
…
```

One block. No retries. ~1.6s end-to-end vs. ~21s under the old
retry-until-max-deliveries behavior.

## Compare: pre-PR

Before this PR the same scenario emitted:

1. `POST /.well-known/workflow/v1/step 500 in 213ms` followed by 3 queue
   retries (attempts 2, 3, 4) — all producing near-identical error blocks
   — before the workflow finally failed with
   `FatalError: Step "..." exceeded max retries (4 retries)`. Total
   wall-clock: ~21 seconds of guaranteed-to-fail work.
2. `errorMessage` / `errorStack` contained literal `\x1B[...m` ANSI escape
   bytes, making structured log drains unreadable.
3. The step-level log embedded the full stack inside an `errorStack`
   string field — terminal reading was significantly worse than the
   workflow-level log. Fixed in this PR (see Scenario 01 for the
   general rendering change).
4. No `errorAttribution` field.
5. No `hint` field / docs link.

## Related changesets

- `.changeset/friendlier-serialization-errors.md` — SerializationError class + friendly hints
- `.changeset/serialization-error-fatal.md` — mark fatal + route dehydration through step-failure path
- `.changeset/log-readability.md` — inline stack + friendly names in step-level logs
- `.changeset/friendlier-logger-metadata.md` — `[workflow-sdk]` prefix
