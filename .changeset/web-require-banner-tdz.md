---
"@workflow/web": patch
---

Check `globalThis.require` in the bundled server's `createRequire` banner, so a chunk that declares its own `require` binding loads instead of failing with `ReferenceError: Cannot access 'require' before initialization`.
