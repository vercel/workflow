# @workflow/core

Core runtime package for [Workflow SDK](https://workflow-sdk.dev).

Workflow replay retains a small bounded in-process prefix cache for append-only
event logs. Every reuse still loads events after the cached cursor before
executing user workflow code, so a warm process does not replay stale state.
