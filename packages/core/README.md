# @workflow/core

Core runtime package for [Workflow SDK](https://workflow-sdk.dev).

Queued step messages carry immutable run identity in `runContext`, so step
execution skips the initial `runs.get` and fetches the run row only when
continuing into workflow replay. Messages from older producers without
`runContext` retain the initial fetch.
