---
"@workflow/swc-plugin": major
---

**BREAKING CHANGE**: Inline all step registrations as self-contained IIFEs instead of generating `import { registerStepFunction } from "workflow/internal/private"`. Closure variable access is also inlined. This eliminates the dependency on the `workflow` package being available in `node_modules`, enabling 3rd-party packages to define step functions. Registrations are now placed immediately after each function definition instead of being batched at the bottom of the file.
