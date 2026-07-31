---
'@workflow/core': patch
'workflow': patch
---

Serializing values built inside the workflow VM no longer executes workflow code: classification uses engine brand checks and extraction uses host intrinsics captured at boot, so patched prototypes, spoofed `Symbol.toStringTag`, and shadowed view metadata cannot influence or be triggered by serialization. Unavoidable executions (getters, proxies, custom serializers) are reported as OTel span attributes.
