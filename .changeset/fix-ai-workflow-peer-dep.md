---
"@workflow/ai": patch
---

Use `workspace:^` for the `workflow` peer dependency so that pnpm resolves the correct version range at publish time, fixing `changeset version` warnings about mismatched dependency versions.
