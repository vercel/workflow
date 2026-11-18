---
'@workflow/core': patch
---

Keep the retained workflow VM when a step argument is an instance of a class with a custom `[WORKFLOW_SERIALIZE]` (for example an AI SDK model passed to a step), so agent loops no longer replay the whole event log once per iteration. The serializer now runs at the step call site, on every replay.
