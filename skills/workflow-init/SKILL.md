---
name: workflow-init
description: Install and configure Vercel Workflow DevKit before it exists in node_modules. Use when the user asks to "install workflow", "set up workflow", "add durable workflows", "configure workflow devkit", or "init workflow" for Next.js, Express, Hono, Fastify, NestJS, Nitro, Nuxt, Astro, SvelteKit, or Vite.
metadata:
  author: Vercel Inc.
  version: '1.0'
---

# workflow-init

Initial setup of Vercel Workflow DevKit **before** `workflow` is installed. Fetch the official getting-started guide for the user's framework.

## Decision Flow

### 0) Sanity check
Read `package.json`. If `workflow` is already a dependency, tell the user to use `/workflow` instead (it reads versioned docs from `node_modules/workflow/docs/`). Only continue if workflow is missing.

### 1) Determine the framework
**Non-interactive:** If the user named a framework in their prompt, use it directly.

**Auto-detect:** Inspect `package.json` deps and config files. Use the first match:

1. **Next.js** - `next` dep or `next.config.*`
2. **Nuxt** - `nuxt` dep or `nuxt.config.*`
3. **SvelteKit** - `@sveltejs/kit` dep or `svelte.config.*`
4. **Astro** - `astro` dep or `astro.config.*`
5. **NestJS** - `@nestjs/core` dep or `nest-cli.json`
6. **Nitro** - `nitro` dep or `nitro.config.*`
7. **Express** - `express` dep
8. **Fastify** - `fastify` dep
9. **Hono** - `hono` dep
10. **Vite** - `vite` dep (and not matched above)

If no match or multiple matches, ask the user to pick.

### 2) Fetch and follow the getting-started guide
Fetch **exactly one** of these URLs and follow the guide step-by-step:

| Framework | URL |
|-----------|-----|
| Next.js | https://useworkflow.dev/docs/getting-started/next |
| Express | https://useworkflow.dev/docs/getting-started/express |
| Hono | https://useworkflow.dev/docs/getting-started/hono |
| Fastify | https://useworkflow.dev/docs/getting-started/fastify |
| NestJS | https://useworkflow.dev/docs/getting-started/nestjs |
| Nitro | https://useworkflow.dev/docs/getting-started/nitro |
| Nuxt | https://useworkflow.dev/docs/getting-started/nuxt |
| Astro | https://useworkflow.dev/docs/getting-started/astro |
| SvelteKit | https://useworkflow.dev/docs/getting-started/sveltekit |
| Vite | https://useworkflow.dev/docs/getting-started/vite |

Each guide covers: install deps, configure framework, create first workflow, create route handler, run + verify.

### 3) Verify setup
- Start the dev server per the guide.
- Trigger the example endpoint with the provided `curl`.
- Confirm logs show the workflow and steps executing.
- Optional: `npx workflow web` or `npx workflow inspect runs`.

### 4) No framework yet?
If no framework exists, ask what the user wants:
- **Web app**: Next.js / Nuxt / SvelteKit / Astro
- **API server**: Express / Fastify / Hono
- **Minimal server**: Nitro or Vite

Then follow the "Create Your Project" section of the chosen guide.

## Concept questions (pre-install)
If the user asks conceptual questions before installing, fetch:
- https://useworkflow.dev/docs/foundations/workflows-and-steps
- https://useworkflow.dev/docs/foundations/common-patterns

## Handoff
When setup is complete, tell the user: **Use `/workflow` for ongoing development** - it reads the versioned docs bundled in `node_modules/workflow/docs/`.
