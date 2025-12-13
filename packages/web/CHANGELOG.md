# @workflow/web

## 4.0.1-beta.16

### Patch Changes

- [#604](https://github.com/vercel/workflow/pull/604) [`6265534`](https://github.com/vercel/workflow/commit/6265534d6be2cba54265ef23b94a0810d9e25c9c) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Bump next.js to address CVE-2025-55184

## 4.0.1-beta.15

### Patch Changes

- [#575](https://github.com/vercel/workflow/pull/575) [`161c54c`](https://github.com/vercel/workflow/commit/161c54ca13e0c36220640e656b7abe4ff282dbb0) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add Web and CLI UI for listing and viewing streams

- [#572](https://github.com/vercel/workflow/pull/572) [`33c254c`](https://github.com/vercel/workflow/commit/33c254c82c1c452300d6bff531c33329aa01d4ec) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Refactor error handling to surface more error details and reduce code

- [#562](https://github.com/vercel/workflow/pull/562) [`058757c`](https://github.com/vercel/workflow/commit/058757c476579a7b1bb6a8ba9a3d15f57b30c898) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Unify time helper functions

## 4.0.1-beta.14

### Patch Changes

- 14daedd: Refine span viewer panel UI: reduced font sizes and spacing, added connecting lines in detail cards, improved attribute layout with bordered containers. Improve status badge with colored indicators and optional duration, add overlay mode to copyable text, simplify stream detail back navigation
- 4aecb99: Add workflow graph visualization to observability UI and o11y migration to nuqs for url state management
- 24e6271: UI polish: inline durations, font fixes, trace viewer scrolling fix
- 8172455: Show expiredAt date in trace viewer, add tooltip

## 4.0.1-beta.13

### Patch Changes

- ca27c0f: Update to latest Next.js

## 4.0.1-beta.12

### Patch Changes

- 109fe59: Add PostgreSQL backend support in web UI settings
- 10c5b91: Update Next.js version to 16
- 8d4562e: Rename leftover references to "embedded world" to be "local world"

## 4.0.1-beta.11

### Patch Changes

- b97b6bf: Lock all dependencies in our packages

## 4.0.1-beta.10

### Patch Changes

- 11469d8: Update default fallback path for connecting to local world
- 00efdfb: Improve trace viewer load times and loading animation

## 4.0.1-beta.9

### Patch Changes

- 0b3e89e: Fix event data serialization for observability

## 4.0.1-beta.8

### Patch Changes

- 7db9e94: Fix hook events not displaying on trace viewer if there's multiple hook_received events

## 4.0.1-beta.7

### Patch Changes

- 2ae7426: Clean up loading animation on trace viewer
- f973954: Update license to Apache 2.0
- 2ae7426: Export react-jsx transpiled code, not raw jsx

## 4.0.1-beta.6

### Patch Changes

- 8f63385: Add readme section about self-hosting observability UI
- 20d51f0: Add optional `retryAfter` property to `Step` interface
- 55e2d0b: Extract reusable web UI code into shared package

## 4.0.1-beta.5

### Patch Changes

- 0f845af: Alias workflow web to workflow inspect runs --web, hide trace viewer search for small runs
- ffb7af3: Web: make error handling local/inline to where it's used, unify API error responses

## 4.0.1-beta.4

### Patch Changes

- dbf2207: Web: refactor active/hover styles from trace viewer to avoid color conflicts
- eadf588: Add button to re-run workflows

## 4.0.1-beta.3

### Patch Changes

- 731adff: Fix run data not updating live on run detail view
- 22917ab: Web: fix resource detail sidebar briefly showing old data when updating selection
- 66225bf: Web: Allow filtering by workflow name and status on the runs list view
- 9ba86ce: Web: fix links to docs

## 4.0.1-beta.2

### Patch Changes

- f5f171f: Refactor trace-viewer API, fix visibility of tiny traces

## 4.0.1-beta.1

### Patch Changes

- e46294f: Add "license" and "repository" fields to `package.json` file

## 4.0.1-beta.0

### Patch Changes

- fcf63d0: Initial publish
