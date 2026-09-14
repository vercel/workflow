# @workflow/core

Core runtime package for [Workflow SDK](https://workflow-sdk.dev).

Queued step messages carry immutable run identity in `runContext`, so step
execution skips the initial `runs.get` and fetches the run row only when
continuing into workflow replay. Messages from older producers without
`runContext` retain the initial fetch.

When a World advertises `capabilities.invoke`, `resumeHook()` sends the serialized
input through `world.invoke()` and awaits the executor's decision. The executor
services the optional queue-handler invocation feed alongside execution, validates
the hook, writes its event, and then responds. The event and response writes are
sequential, not atomic. Other Worlds retain the existing producer-write/wake path.
Input admission remains active during inline steps; workflow code advances at its
existing replay boundaries. A retained Node VM can continue over newly committed
inputs within the executor's bounded idle window.
