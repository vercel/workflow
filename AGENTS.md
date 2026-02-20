# Agent Instructions

**CRITICAL RULES:**
- NEVER push directly to the `main` branch
- Do not remove or break agent-discoverable docs sitemap behavior: keep docs/app/sitemap.md/route.ts and docs/app/[lang]/sitemap.md/route.ts, and keep the sitemap link in docs/app/[lang]/llms.mdx/[[...slug]]/route.ts.

## SWC Plugin

When modifying the SWC compiler plugin (`packages/swc-plugin-workflow`), you must also update the specification document at `packages/swc-plugin-workflow/spec.md` to reflect any changes to the transformation behavior.
