# @workflow/core

Core runtime package for [Workflow SDK](https://workflow-sdk.dev).

## Event replay cache

Workflow replay retains a small bounded in-process prefix cache for append-only
event logs. The cache is scoped by `World` instance, so separate world
instances never share run/cursor state. Every reuse still loads events after
the cached cursor before executing user workflow code, so a warm process does
not replay stale state.

The cache is enabled by default. Configure it with:

| Variable | Default | Description |
| --- | --- | --- |
| `WORKFLOW_DISABLE_EVENT_CACHE` | unset | Set to `1` to force the cold full-load path. |
| `WORKFLOW_EVENT_CACHE_MAX_BYTES` | `4 MiB` (`4194304`) | Total retained event-prefix bytes per `World` instance. |
| `WORKFLOW_EVENT_CACHE_MAX_ENTRIES` | `64` | Maximum cached event-prefix entries per `World` instance. |

Invalid values are ignored with a warning and fall back to the defaults above.
