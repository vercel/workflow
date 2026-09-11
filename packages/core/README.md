# @workflow/core

Core runtime package for [Workflow SDK](https://workflow-sdk.dev).

Register `onRunCompleted` and `onRunFailed` handlers with `registerLifecycleHooks`
from `workflow/api` for best-effort reporting of terminal transitions written by
your app. Handlers receive the workflow name without a backend read, a lazy `Run`
instance, and, for failures, an error hydrated from the persisted payload.
Callbacks are not retried; the event log remains the system of record.
