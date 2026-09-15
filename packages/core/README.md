# @workflow/core

Core runtime package for [Workflow SDK](https://workflow-sdk.dev).

Queued step messages carry immutable run identity in `runContext`, so step
execution skips the initial `runs.get` and fetches the run row only when
continuing into workflow replay. Messages from older producers without
`runContext` retain the initial fetch.

When a World advertises `capabilities.invoke`, `resumeHook()` sends supported
serialized inputs through `world.invoke()` and awaits the executor's decision.
World delivers an ordinary handler call with `invoke: true`, `requestId` and
`input`. Core validates the hook, awaits its event write, and returns a decision;
World owns iteration and response storage. Core shares a run's admission/activity
state between ordinary execution and these input calls. It does not expose or
consume a World mailbox/feed API.

Event and response writes remain sequential. On Worlds with `hookResumeDedup`,
the stable request identity makes the event write idempotent, including retries
after hook disposal/run completion. Other Worlds and legacy payloads retain the
producer-write/wake path. Input admission remains active during inline steps;
workflow code advances at existing replay boundaries, reusing a retained Node VM
when available.
