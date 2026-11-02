---
"@workflow/builders": patch
---

Stop fast discovery from following type-only imports in TypeScript files (`import type`, `export type`, inline `type` specifiers, and `typeof import()`), so it no longer registers steps that are never used at runtime.
