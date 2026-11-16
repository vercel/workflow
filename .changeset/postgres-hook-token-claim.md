---
"@workflow/world-postgres": patch
---

Fix concurrent forced hook claims in Postgres World. When several runs called `createHook()` with `experimental_force: true` (`force: true` once renamed) on one token at the same time, some of them could get a plain `hook_conflict`, which fails the run with "the configured World does not support force-claiming hook tokens", or a 503 "changed owner 5 times while being force-claimed". Every forced claim now ends registered, and the claims form one chain to the final owner.
