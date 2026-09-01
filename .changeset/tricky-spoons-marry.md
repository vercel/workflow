---
'@workflow/world-local': minor
---

Implement `experimental_retention: 0` in the Local World. When a run whose attributes carry `$retention: '0'` reaches a terminal state, its user payloads are deleted: the run's own input, output and error, its steps' input, output and error, its events' payloads, the metadata on any hook that outlives it, and its streams' contents. The run, step and event records themselves are kept, so a purged run stays listable and its history stays walkable — only the data inside it goes.

The run is stamped with `expiredAt` at the moment it is purged, in the same write that drops its payloads. That is what makes the deletion legible rather than silent: the CLI and web UI render `<data expired>` off it, and `await run.returnValue` throws `RunExpiredError` instead of resolving to nothing.

Every other value keeps the data — an absent attribute, `'default'`, a non-zero duration (whose unit is not decided yet, so no World can honor it), and anything malformed. Deleting data on the strength of a value the World does not understand is the one failure that cannot be undone.
