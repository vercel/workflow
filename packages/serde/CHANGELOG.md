# @workflow/serde

## 4.1.1

### Patch Changes

- [#1726](https://github.com/vercel/workflow/pull/1726) [`6f48e9e`](https://github.com/vercel/workflow/commit/6f48e9e778d73d42ade3762ba3fff0e46877a812) Thanks [@workflow-devkit-release-bot](https://github.com/apps/workflow-devkit-release-bot)! - Embed source content in published sourcemaps.

## 4.1.0

### Patch Changes

- [#1640](https://github.com/vercel/workflow/pull/1640) [`8890b33`](https://github.com/vercel/workflow/commit/8890b33b9b6497824309ced298a7b1acab73142c) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Stable release

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
