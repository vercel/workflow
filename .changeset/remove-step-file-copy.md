---
"@workflow/next": patch
---

Simplify the deferred builder by removing the step file copy mechanism. Step sources are now imported directly into the generated `step/route.js`, matching how serde files are already handled. The `.well-known/workflow/v1/step/__workflow_step_files__/` directory is no longer generated; the builder still removes stale copies from previous versions on boot.
