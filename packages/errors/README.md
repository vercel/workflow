# @workflow/errors

Centralized errors package for [Workflow SDK](https://workflow-sdk.dev).

`@workflow/errors/invocation` provides `captureInvocationOutcome` and
`unwrapInvocationOutcome` for World request/response transports. The shared
`InvocationOutcome` type lives in `@workflow/world`. Error outcomes preserve known
Workflow error class identity, message, stack, causes, and diagnostic fields;
unknown classes are restored as `Error` with their original name/fields.
`serializeWorkflowError` / `deserializeWorkflowError` are also available.
Wire transports must preserve binary values and dates in diagnostic fields.
Getters are omitted and cyclic/deep diagnostic values are bounded. Only capture
the handler call: transport/response-storage failures must remain unknown outcomes.
