# @workflow/typescript-plugin

## 5.0.0-beta.2

### Patch Changes

- [#1769](https://github.com/vercel/workflow/pull/1769) [`5a42964`](https://github.com/vercel/workflow/commit/5a4296412f151c255a8d08c8870e511222c7c472) Thanks [@tomdale](https://github.com/tomdale)! - Embed source content in published sourcemaps.

- [#1759](https://github.com/vercel/workflow/pull/1759) [`173756d`](https://github.com/vercel/workflow/commit/173756dc4d097fd90432e2c38c91ce1b959a6352) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Rename `useworkflow.dev` URLs to `workflow-sdk.dev`

## 5.0.0-beta.1

### Minor Changes

- [#1633](https://github.com/vercel/workflow/pull/1633) [`d040182`](https://github.com/vercel/workflow/commit/d0401829320c2880a0a5c2404ed9dede94eb17a0) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Allow synchronous functions to use `"use step"` directive. This enables using `"use step"` as a mechanism to strip Node.js-dependent code from the workflow VM bundle without requiring the function to be async.

## 5.0.0-beta.0

### Major Changes

- [#1642](https://github.com/vercel/workflow/pull/1642) [`c5cdfc0`](https://github.com/vercel/workflow/commit/c5cdfc00751c5bef36c4be748d819081b934fbcd) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Initial v5 beta release

## 4.0.1-beta.5

### Patch Changes

- [#1217](https://github.com/vercel/workflow/pull/1217) [`e55c636`](https://github.com/vercel/workflow/commit/e55c63678b15b6687cc77efca705ee9fb40fabc3) Thanks [@pranaygp](https://github.com/pranaygp)! - Upgrade dependencies across all packages

## 4.0.1-beta.4

### Patch Changes

- 5078925: Add warning when invoking a workflow function without using `start()`
- f973954: Update license to Apache 2.0
- fcadd7b: Fix TypeScript LSP plugin for Node.js v20

## 4.0.1-beta.3

### Patch Changes

- 99b4727: Convert docs link on directive from diagnostics to hover hint

## 4.0.1-beta.2

### Patch Changes

- e20b4ff: Add "use step" and "use workflow" typo detection and link to documentation

## 4.0.1-beta.1

### Patch Changes

- 1408293: Add "description" field to `package.json` file
- 8422a32: Update Workflow naming convention
- e46294f: Add "license" and "repository" fields to `package.json` file

## 4.0.1-beta.0

### Patch Changes

- fcf63d0: Initial publish
