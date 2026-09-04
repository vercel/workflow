---
"@workflow/next": patch
"@workflow/builders": patch
---

Fix lazy discovery bare specifier resolution in copied step files

- Use `enhanced-resolve` with ESM conditions to resolve bare specifiers from the original source file's location
- Only rewrite specifiers that can't resolve from the app directory (transitive SDK deps)
- Add `enhanced-resolve` to pnpm catalog and use `catalog:` in both packages
