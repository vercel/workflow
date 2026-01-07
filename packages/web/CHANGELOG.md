# @workflow/web

## 4.0.1-beta.24

### Patch Changes

- [#716](https://github.com/vercel/workflow/pull/716) [`0da8e54`](https://github.com/vercel/workflow/commit/0da8e543742ad160dedc28f998cfe16fe1e3fd84) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Allow selecting and cancelling multiple runs from table view

- [#717](https://github.com/vercel/workflow/pull/717) [`8bc4e5f`](https://github.com/vercel/workflow/commit/8bc4e5fe3ccd67ccdd39737d3d30ad4268215a27) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Refresh run table on stale re-focus

## 4.0.1-beta.23

### Patch Changes

- [#703](https://github.com/vercel/workflow/pull/703) [`9b1640d`](https://github.com/vercel/workflow/commit/9b1640d76e7e759446058d65272011071bb250d2) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Use `pluralize()` util function

## 4.0.1-beta.22

### Patch Changes

- [#694](https://github.com/vercel/workflow/pull/694) [`f989613`](https://github.com/vercel/workflow/commit/f989613d7020f987fba2c74f2e49c8d47ff74a29) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add error boundaries around tabs in run detail view

## 4.0.1-beta.21

### Patch Changes

- [#455](https://github.com/vercel/workflow/pull/455) [`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Added Control Flow Graph extraction from Workflows and extended manifest.json's schema to incorporate the graph structure into it. Refactored manifest generation to pass manifest as a parameter instead of using instance state. Add e2e tests for manifest validation across all builders.

## 4.0.1-beta.20

### Patch Changes

- [#674](https://github.com/vercel/workflow/pull/674) [`4bc98ff`](https://github.com/vercel/workflow/commit/4bc98ff4a15a090e2233c18b75e0a1b5dd2e9ff1) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Move ErrorBoundary component from web to web-shared and use in sidebar detail view.

## 4.0.1-beta.19

### Patch Changes

- [#656](https://github.com/vercel/workflow/pull/656) [`ef22f82`](https://github.com/vercel/workflow/commit/ef22f82c9ead53744bac23fa12ed6bfbb1aba0bb) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Allow resuming hooks with payloads from the UI

## 4.0.1-beta.18

### Patch Changes

- [#646](https://github.com/vercel/workflow/pull/646) [`f396833`](https://github.com/vercel/workflow/commit/f39683370dc187273bd8aa5108e11e49dffe027a) Thanks [@adriandlam](https://github.com/adriandlam)! - Fix missing next.config.ts inside built @workflow/web package

## 4.0.1-beta.17

### Patch Changes

- [#582](https://github.com/vercel/workflow/pull/582) [`05ea678`](https://github.com/vercel/workflow/commit/05ea6789e5773d5b4ee16dce4a800e613261f452) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add buttons to wake up workflow from sleep or scheduling issues

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
