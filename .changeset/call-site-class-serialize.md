---
'@workflow/core': patch
---

Keep the retained workflow VM when a step argument is an instance of a class with a custom `[WORKFLOW_SERIALIZE]` (for example an AI SDK model passed to a step), so agent loops no longer replay the whole event log once per iteration. For top-level step arguments the serializer now runs when the step is called, on every replay, rather than when the step input is written: the step receives the instance as it was at the call, and a serializer's side effects are seen identically by retained and cold replays. Instances nested inside other arguments, step receivers (`instance.someStep()`) and closure variables are serialized as before.
