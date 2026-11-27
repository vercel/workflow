# @workflow/serde

## 5.0.1

### Patch Changes

- [#5367](https://github.com/vercel/workflow/pull/5367) [`7404b8f`](https://github.com/vercel/workflow/commit/7404b8f4cae9c09887deb3bcb2bb1f646ee6db0f) Thanks [@pranaygp](https://github.com/pranaygp)! - Publish smaller packages: compiled tests and declaration maps are no longer included, `@workflow/world` no longer ships its TypeScript sources, and the inline source maps no longer embed the original sources. Stack traces still map to the original file, line and column, but since `src/` is not published, debuggers and dev-server error overlays no longer show source code for frames inside `@workflow/*` packages. `@workflow/web-shared` also stops publishing its tests.

## 5.0.0

### Major Changes

- [#1217](https://github.com/vercel/workflow/pull/1217) [`e55c636`](https://github.com/vercel/workflow/commit/e55c63678b15b6687cc77efca705ee9fb40fabc3) Thanks [@pranaygp](https://github.com/pranaygp)! - Initial v5 beta release

### Patch Changes

- [#1769](https://github.com/vercel/workflow/pull/1769) [`5a42964`](https://github.com/vercel/workflow/commit/5a4296412f151c255a8d08c8870e511222c7c472) Thanks [@tomdale](https://github.com/tomdale)! - Embed source content in published sourcemaps.

- [#1799](https://github.com/vercel/workflow/pull/1799) [`503a929`](https://github.com/vercel/workflow/commit/503a929d347df46eb0ad63b068da7781762d0dc8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Use inline sourcemaps for all workspace packages; published packages no longer ship external `.js.map` files.

## 5.0.0-beta.2

### Patch Changes

- [#1799](https://github.com/vercel/workflow/pull/1799) [`503a929`](https://github.com/vercel/workflow/commit/503a929d347df46eb0ad63b068da7781762d0dc8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Use inline sourcemaps for all workspace packages; published packages no longer ship external `.js.map` files.

## 5.0.0-beta.1

### Patch Changes

- [#1769](https://github.com/vercel/workflow/pull/1769) [`5a42964`](https://github.com/vercel/workflow/commit/5a4296412f151c255a8d08c8870e511222c7c472) Thanks [@tomdale](https://github.com/tomdale)! - Embed source content in published sourcemaps.

## 5.0.0-beta.0

### Major Changes

- [#1642](https://github.com/vercel/workflow/pull/1642) [`c5cdfc0`](https://github.com/vercel/workflow/commit/c5cdfc00751c5bef36c4be748d819081b934fbcd) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Initial v5 beta release

## 4.1.0-beta.2

### Minor Changes

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - **BREAKING**: Storage interface is now read-only; all mutations go through `events.create()`
  - Remove `cancel`, `pause`, `resume` from `runs`
  - Remove `create`, `update` from `runs`, `steps`, `hooks`
  - Add run lifecycle events: `run_created`, `run_started`, `run_completed`, `run_failed`, `run_cancelled`
  - Add `step_created` event type
  - Remove `fatal` field from `step_failed` (terminal failure is now implicit)
  - Add `step_retrying` event with error info for retriable failures

## 4.0.1-beta.1

### Patch Changes

- [`8621917`](https://github.com/vercel/workflow/commit/8621917f6e03ae0f3833defa0f6e548434103c9d) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Initial release
