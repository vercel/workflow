---
"@workflow/swc-plugin": patch
"@workflow/builders": patch
"@workflow/rollup": patch
"@workflow/next": patch
---

Change compiler ID generation logic to use Node.js import specifiers

IDs for workflows, steps, and classes now use module specifiers:
- Local files use `./path/to/file` format instead of `path/to/file.ext`
- Package files use `packageName@version` format (e.g., `workflow@4.0.1`)

This enables stable IDs across different package.json export conditions.
