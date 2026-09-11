---
'@workflow/core': patch
---

Fix a host-process crash when a run fails before its body starts (an unregistered workflow name, a bundle that fails to evaluate, input that fails to hydrate) while the event log still holds an unconsumed event: the consumer's deferred divergence check rejected an interruption promise nothing had awaited yet, which surfaced as an `unhandledRejection` about 100ms after the flow route had already reported the run as failed.
