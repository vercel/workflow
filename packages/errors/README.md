# @workflow/errors

Centralized errors package for [Workflow SDK](https://workflow-sdk.dev).

Use `captureInvocationOutcome` and `unwrapInvocationOutcome` from
`@workflow/errors/invocation` to transport a handler's return value or error. Both
use the `InvocationOutcome` type from `@workflow/world`.

Error outcomes preserve known Workflow error classes, messages, stacks, causes,
and diagnostic fields. Unrecognized classes become `Error` instances with their
original names and fields. The module also exports `serializeWorkflowError` and
`deserializeWorkflowError` for converting individual errors.

Diagnostic serialization omits object accessors and bounds circular or deeply
nested values. The transport must preserve `Uint8Array` and `Date` values in
diagnostic fields.

Wrap the handler call with `captureInvocationOutcome`, then store or deliver the
outcome separately. Storage and transport failures leave the caller uncertain
whether processing succeeded. By default, the helper captures every thrown error.
Pass `isTerminalInvocationError` as its second argument to rethrow transient or
unrecognized failures for the delivery layer to retry. The Postgres World uses
this retry policy.
