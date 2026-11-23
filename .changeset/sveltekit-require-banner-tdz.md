---
"@workflow/sveltekit": patch
---

Check `globalThis.require` in the server build's `createRequire` banner, so a chunk that declares its own `require` binding loads instead of failing with `ReferenceError: Cannot access 'require' before initialization`.
