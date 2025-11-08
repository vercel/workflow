---
"@workflow/world-local": major
---

BREAKING: Change `createEmbeddedWorld` API signature from positional parameters to config object. Add baseUrl configuration support.

**Breaking change:**
- `createEmbeddedWorld(dataDir?, port?)` → `createEmbeddedWorld(args?: Partial<Config>)`

**New features:**
- Add `baseUrl` config option for HTTPS and custom hostnames
- Automatic port detection via `@workflow/utils/get-port`
- Support for port 0 (OS-assigned port)
