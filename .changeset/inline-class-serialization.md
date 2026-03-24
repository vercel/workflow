---
"@workflow/swc-plugin-workflow": patch
---

Inline class serialization registration instead of importing from `workflow/internal/class-serialization`. This eliminates the dependency on the `workflow` package in SWC-generated code, enabling 3rd-party packages (like `@vercel/sandbox`) to define serializable classes without needing `workflow` as a dependency.
