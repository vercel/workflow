# @workflow/utils

## 4.0.1-beta.9

### Patch Changes

- [#455](https://github.com/vercel/workflow/pull/455) [`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Added Control Flow Graph extraction from Workflows and extended manifest.json's schema to incorporate the graph structure into it. Refactored manifest generation to pass manifest as a parameter instead of using instance state. Add e2e tests for manifest validation across all builders.

## 4.0.1-beta.8

### Patch Changes

- [#682](https://github.com/vercel/workflow/pull/682) [`0cf0ac3`](https://github.com/vercel/workflow/commit/0cf0ac32114bcdfa49319d27c2ce98da516690f1) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Extract helper to find local world dataDir across CLI/web projects

## 4.0.1-beta.7

### Patch Changes

- [#616](https://github.com/vercel/workflow/pull/616) [`1ef6b2f`](https://github.com/vercel/workflow/commit/1ef6b2fdc8dc7e4d665aa2fe1a7d9e68ce7f1e95) Thanks [@adriandlam](https://github.com/adriandlam)! - Update port detection to probe workflow health check endpoint

## 4.0.1-beta.6

### Patch Changes

- [#590](https://github.com/vercel/workflow/pull/590) [`c9b8d84`](https://github.com/vercel/workflow/commit/c9b8d843fd0a88de268d603a14ebe2e7c726169a) Thanks [@adriandlam](https://github.com/adriandlam)! - Improve port detection with HTTP probing

## 4.0.1-beta.5

### Patch Changes

- bc9b628: Prevent @vercel/nft from tracing /proc paths during build
- 34f3f86: fix(utils): detect linux ports via /proc
- cd451e0: Replace execa dependency with built-in node execFile

## 4.0.1-beta.4

### Patch Changes

- edb69c3: Fix port detection and base URL resolution for dev servers

## 4.0.1-beta.3

### Patch Changes

- b97b6bf: Lock all dependencies in our packages

## 4.0.1-beta.2

### Patch Changes

- bf170ad: Add initial `@workflow/utils` package
- adf0cfe: Add automatic port discovery
