---
"@workflow/core": patch
---

Harden the VM context by disabling dynamic code generation (eval/new Function/WebAssembly) and preventing leakage of the host console into the VM realm.
