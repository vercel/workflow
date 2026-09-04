---
'@workflow/nest': major
---

Add `workflow-nest build --vercel` command for emitting a Vercel Build Output API directory, enabling deployment of NestJS apps on Vercel. **Breaking:** `NestLocalBuilder` moved from the package root to the `@workflow/nest/builder` (`workflow/nest/builder`) subpath so importing `WorkflowModule` no longer pulls the build toolchain into the runtime bundle; the new `NestVercelBuilder` lives at `@workflow/nest/vercel-builder` (`workflow/nest/vercel-builder`).
