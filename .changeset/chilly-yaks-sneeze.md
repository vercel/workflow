---
"@workflow/world-local": major
---

BREAKING: Change `createEmbeddedWorld` API signature from positional parameters to config object. Add baseUrl configuration support and fix port 0 handling.

**Breaking change:**
- `createEmbeddedWorld(dataDir?, port?)` → `createEmbeddedWorld(args?: Partial<Config>)`

**New features:**
- Add `baseUrl` config option for HTTPS and custom hostnames
- Automatic port detection via `@workflow/utils/get-port`

**Bug fixes:**
- Port 0 (OS-assigned port) now works correctly
- Null port values properly fall through to auto-detection
