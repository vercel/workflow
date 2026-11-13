---
"@workflow/core": patch
---

Update `quickjs-wasi` to 3.7.0 (QuickJS-NG v0.18.0). The QuickJS runtime now reads engine-captured Error stacks through the `Error.prototype.stack` accessor, so errors thrown from workflows keep their stack traces.
