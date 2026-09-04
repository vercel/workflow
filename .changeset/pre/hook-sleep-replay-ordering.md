---
"@workflow/core": patch
---

Fix `CorruptedEventLogError` on replay when a workflow races a hook read against a `sleep()` (e.g. `Promise.race([hook, sleep])`). Branch-deciding deliveries (buffered hook payloads and wait completions) are now handed to the workflow in strict event-log order — anchored on event position rather than on microtask-resolution timing — so the committed branch wins the race deterministically, independent of decryption/hydration time or `Promise.race` argument order.
