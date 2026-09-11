---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/ai': patch
'@workflow/nest': patch
---

Hold process-wide state on `globalThis` rather than at module scope in the packages that get bundled into the host application's server build, where a bundler compiles one copy of each module per layer. Covers warn-once latches, lazy caches, the VM script and QuickJS asset caches, the dev-server port cache, and step single-flight, whose per-copy map was not actually single-flight. State that is deliberately per-copy is annotated with the reason.
