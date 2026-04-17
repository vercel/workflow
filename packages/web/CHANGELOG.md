# @workflow/web

## 4.1.5

## 4.1.4

### Patch Changes

- [#1776](https://github.com/vercel/workflow/pull/1776) [`c556da3`](https://github.com/vercel/workflow/commit/c556da32d711c95a7e27b9d6848cb5a7f3bbb62e) Thanks [@workflow-devkit-release-bot](https://github.com/apps/workflow-devkit-release-bot)! - Disable Vite minification so the published build contains readable code, reducing false-positive obfuscation flags from supply chain security scanners (Socket).

## 4.1.1

### Patch Changes

- [`f1cc68f`](https://github.com/vercel/workflow/commit/f1cc68f76a25241cd47058e5c2f5855d051dea71) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Make encrypted markers clickable to trigger decryption and detect encryption at run level before span selection. Persist `features.encryption` flag in `executionContext` at run creation so the UI can detect encryption without a probe fetch.

## 4.1.0

### Patch Changes

- [#1640](https://github.com/vercel/workflow/pull/1640) [`8890b33`](https://github.com/vercel/workflow/commit/8890b33b9b6497824309ced298a7b1acab73142c) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Stable release

## 4.1.0-beta.47

### Patch Changes

- [#1590](https://github.com/vercel/workflow/pull/1590) [`74c4cdb`](https://github.com/vercel/workflow/commit/74c4cdb6519802e3d56760e971507ffb93bc945b) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix server crash on unmatched routes (e.g. /robots.txt, /favicon.ico)

## 4.1.0-beta.46

### Patch Changes

- [#1542](https://github.com/vercel/workflow/pull/1542) [`c488877`](https://github.com/vercel/workflow/commit/c488877727d693e761ecbaae1e86bac4fb1f1e2c) Thanks [@karthikscale3](https://github.com/karthikscale3)! - fix: switch web stream reader from readFromStream to getStreamChunks

## 4.1.0-beta.45

### Patch Changes

- [#1492](https://github.com/vercel/workflow/pull/1492) [`dab106a`](https://github.com/vercel/workflow/commit/dab106acd3556f49db295108a3cdccc8058a7b92) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Hide the workflow graph viewer tab

- [#1515](https://github.com/vercel/workflow/pull/1515) [`bb86b69`](https://github.com/vercel/workflow/commit/bb86b695c247980f3ac0fd916aad108d0c05d9be) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Fix Streams tab crash when decrypting large stream chunks

## 4.1.0-beta.44

### Patch Changes

- [#1340](https://github.com/vercel/workflow/pull/1340) [`84599b7`](https://github.com/vercel/workflow/commit/84599b7ec5c19207082523609f1b3508a1a18bd7) Thanks [@pranaygp](https://github.com/pranaygp)! - Add error code classification (`USER_ERROR`, `RUNTIME_ERROR`) to `run_failed` events, improve queue and schema validation error logging

- [#1473](https://github.com/vercel/workflow/pull/1473) [`2b80e2d`](https://github.com/vercel/workflow/commit/2b80e2de35aac170e5dc7d83a1b3f26495a0bbc9) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Fix stream display for streams created before version `4.1.0-beta.56`

## 4.1.0-beta.43

### Patch Changes

- [#1381](https://github.com/vercel/workflow/pull/1381) [`7b9b3c1`](https://github.com/vercel/workflow/commit/7b9b3c1a484a4effff2190ac9899a2608704f375) Thanks [@karthikscale3](https://github.com/karthikscale3)! - web-shared: Timestamp tooltips, toast adapter, improved skeletons, and encrypted data detection for lazy-loaded events
  web: Add toast for decryption

- [#1364](https://github.com/vercel/workflow/pull/1364) [`94c14c7`](https://github.com/vercel/workflow/commit/94c14c746b3218d13a5e2a7936c8cef505e7be08) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Strip only ref/payload fields from eventData when resolveData is 'none', preserving all other metadata

## 4.1.0-beta.42

### Patch Changes

- [#1346](https://github.com/vercel/workflow/pull/1346) [`73c12f1`](https://github.com/vercel/workflow/commit/73c12f14dabb465e2074e2aebbcd231a4d91bc09) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix `ERR_UNSUPPORTED_ESM_URL_SCHEME` on Windows by converting absolute file paths to `file://` URLs before passing them to dynamic `import()`

- [#1358](https://github.com/vercel/workflow/pull/1358) [`5c6ae60`](https://github.com/vercel/workflow/commit/5c6ae607a58d200fbad673821728a1a39684dfd9) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Improve workflow observability UX with decoupled pagination, stream virtualization, and decrypt actions

- [#1366](https://github.com/vercel/workflow/pull/1366) [`d6da7ec`](https://github.com/vercel/workflow/commit/d6da7ecca0fbf94d3331ce3bd7d28644a4f5cc3f) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Fix stale encryptionKey closure in events list data hook in web

## 4.1.0-beta.41

### Patch Changes

- [#1322](https://github.com/vercel/workflow/pull/1322) [`d5bc418`](https://github.com/vercel/workflow/commit/d5bc418816748ab2b5109ca7b082f3be427c326b) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Update readme to call out self-hosting limitations

- [#1327](https://github.com/vercel/workflow/pull/1327) [`d5ae817`](https://github.com/vercel/workflow/commit/d5ae81786303554bbee0e9fa939c92274a883d18) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Improve loading indicators for trace viewer and events list

## 4.1.0-beta.40

### Patch Changes

- [#1261](https://github.com/vercel/workflow/pull/1261) [`887cc2b`](https://github.com/vercel/workflow/commit/887cc2bd55b904c696083d87ab32a9fc03d619a8) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Refactor trace viewer to build spans entirely from events instead of fetching Steps and Hooks as separate resources.

- [#1265](https://github.com/vercel/workflow/pull/1265) [`aa2f581`](https://github.com/vercel/workflow/commit/aa2f581b488baf929a784f289a81e21c39ccb5a6) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add custom `entry.server.tsx` and move `@react-router/node`, `isbot`, `react-router`, and `@react-router/express` to devDependencies since the build process bundles them entirely at build time

- [#1308](https://github.com/vercel/workflow/pull/1308) [`33101a2`](https://github.com/vercel/workflow/commit/33101a229207bafe869fb73686c6bfcc59ab25b0) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Move decrypt operation to the entity panel inside web-shared and wire it up to web via component callback.

## 4.1.0-beta.39

### Patch Changes

- [#1288](https://github.com/vercel/workflow/pull/1288) [`5e4ef65`](https://github.com/vercel/workflow/commit/5e4ef657cf34c04d6d12b9823fb7fca8885c2f90) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Use `world.events.get(eventId)` instead of `listByCorrelationId` for loading individual event data in run detail view.

## 4.1.0-beta.38

### Patch Changes

- [#1278](https://github.com/vercel/workflow/pull/1278) [`1eaff36`](https://github.com/vercel/workflow/commit/1eaff36f197bcaefacac2e89a08c90e735a67644) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Ensure data resolution failure does not prevent run from being inspected in UI

- [#1277](https://github.com/vercel/workflow/pull/1277) [`97932d3`](https://github.com/vercel/workflow/commit/97932d3086b4b7c339e612fb6cac0ffda74545e3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix encrypted stream inspection: move deserialization/decryption client-side, add --decrypt support to CLI

## 4.1.0-beta.37

### Patch Changes

- [#1256](https://github.com/vercel/workflow/pull/1256) [`bbe40ff`](https://github.com/vercel/workflow/commit/bbe40ff00a5e372b040aec8fc7640c54d08c5636) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add encryption-aware o11y for CLI and web UI

## 4.1.0-beta.36

### Patch Changes

- [#1217](https://github.com/vercel/workflow/pull/1217) [`e55c636`](https://github.com/vercel/workflow/commit/e55c63678b15b6687cc77efca705ee9fb40fabc3) Thanks [@pranaygp](https://github.com/pranaygp)! - Upgrade dependencies across all packages

## 4.1.0-beta.35

### Patch Changes

- [#1182](https://github.com/vercel/workflow/pull/1182) [`f0823dc`](https://github.com/vercel/workflow/commit/f0823dc79b74e76176974230cecaccd705a8da75) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Fix traceviewer pagination issues

- [#1070](https://github.com/vercel/workflow/pull/1070) [`a0b99c8`](https://github.com/vercel/workflow/commit/a0b99c8ec83ef602947b671aa9aed91720c170ce) Thanks [@alizenhom](https://github.com/alizenhom)! - Decompose `workflow-api-client.ts` into focused modules with unit tests

- [#1124](https://github.com/vercel/workflow/pull/1124) [`1f9a67c`](https://github.com/vercel/workflow/commit/1f9a67c759fa6444f6f652692871e8bc7e65ea71) Thanks [@kschmelter13](https://github.com/kschmelter13)! - Replace queue `pg-boss`-based implementation with `graphile-worker`

## 4.1.0-beta.34

### Patch Changes

- [#999](https://github.com/vercel/workflow/pull/999) [`ea3254e`](https://github.com/vercel/workflow/commit/ea3254e7ce28cef6b9b829ac7ad379921dd41ed9) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Separate project ID and project name into distinct env vars (WORKFLOW_VERCEL_PROJECT and WORKFLOW_VERCEL_PROJECT_NAME)

- [#1031](https://github.com/vercel/workflow/pull/1031) [`1c11573`](https://github.com/vercel/workflow/commit/1c1157340d88c60c7c80c0789c111050b809ab77) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Refactor and enhance web-shared observability UI components and update builders base behavior.

- [#1039](https://github.com/vercel/workflow/pull/1039) [`5213309`](https://github.com/vercel/workflow/commit/5213309073440515de5212c61538e73d267461e7) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix "dev" mode

- [#1096](https://github.com/vercel/workflow/pull/1096) [`29347b7`](https://github.com/vercel/workflow/commit/29347b79eae8181d02ed1e52183983adc56425fd) Thanks [@ctgowrie](https://github.com/ctgowrie)! - Use new Vercel queue client with v2 message format, simplified callback handling, etc.

## 4.1.0-beta.33

### Patch Changes

- [#1005](https://github.com/vercel/workflow/pull/1005) [`7653e6b`](https://github.com/vercel/workflow/commit/7653e6bfdbfe29624a5cbc1477b299f6aca3a0f0) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Migrate `@workflow/web` from Next.js to React Router v7 framework mode. Replace child process spawning in the CLI with in-process Express server. Switch RPC transport from JSON to CBOR.

- [#1015](https://github.com/vercel/workflow/pull/1015) [`c56dc38`](https://github.com/vercel/workflow/commit/c56dc3848ecf3e188f876dc4cb7861df185bd4fb) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Extract browser-safe serialization format from `@workflow/core` and split o11y hydration by environment. Data hydration now happens client-side in the browser, enabling future e2e encryption support.

- [#992](https://github.com/vercel/workflow/pull/992) [`dc2dc6a`](https://github.com/vercel/workflow/commit/dc2dc6ac7908e57be9ab34140addfe98a9246fc7) Thanks [@ijjk](https://github.com/ijjk)! - stop esbuild bundling for deferred step route in Next.js

## 4.1.0-beta.32

### Patch Changes

- [#927](https://github.com/vercel/workflow/pull/927) [`f090de1`](https://github.com/vercel/workflow/commit/f090de1eb48ad8ec3fd776e9d084310d56a7ac29) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Added subpatch exports for runtime modules to allow direct imports in core. Refactored web-shared to be a thin package that exported UI components and world-actions. Updated web package to consume the UI components and world-actions from web-shared.

## 4.1.0-beta.31

### Minor Changes

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - **BREAKING**: Storage interface is now read-only; all mutations go through `events.create()`
  - Remove `cancel`, `pause`, `resume` from `runs`
  - Remove `create`, `update` from `runs`, `steps`, `hooks`
  - Add run lifecycle events: `run_created`, `run_started`, `run_completed`, `run_failed`, `run_cancelled`
  - Add `step_created` event type
  - Remove `fatal` field from `step_failed` (terminal failure is now implicit)
  - Add `step_retrying` event with error info for retriable failures

### Patch Changes

- [#814](https://github.com/vercel/workflow/pull/814) [`b16a682`](https://github.com/vercel/workflow/commit/b16a6828af36a2d5adb38fb6a6d1253657001ac8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Move "parse-name" into the `utils` package

## 4.0.1-beta.30

### Patch Changes

- [#816](https://github.com/vercel/workflow/pull/816) [`5ba82ec`](https://github.com/vercel/workflow/commit/5ba82ec4b105d11538be6ad65449986eaf945916) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add button to run queue based health checks

## 4.0.1-beta.29

### Patch Changes

- [#806](https://github.com/vercel/workflow/pull/806) [`d30e5c0`](https://github.com/vercel/workflow/commit/d30e5c0249018083bdd63ac84408449003399099) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - [web] Add view to display a list of all events

- [#808](https://github.com/vercel/workflow/pull/808) [`ee7b1fd`](https://github.com/vercel/workflow/commit/ee7b1fd24483c24527d95ba1f5ad444d05b7ffcf) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Fix layout shift when empty run or hook tables auto-refreshes in local environment

## 4.0.1-beta.28

### Patch Changes

- [#774](https://github.com/vercel/workflow/pull/774) [`abdca8f`](https://github.com/vercel/workflow/commit/abdca8fd526f3c83c7da7b96a0522f9552e2bd2f) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Improve display of configuration information. Fix opening of Vercel backend when using `--localUi`. Fix world caching in multi-tenant environments. Fix flicker in run table when refreshing. Improve contributor experience by adding `--observabilityCwd` flag to easily iterate on web UI from another directory. Polish navbar UI.

## 4.0.1-beta.27

### Patch Changes

- [#737](https://github.com/vercel/workflow/pull/737) [`adb9312`](https://github.com/vercel/workflow/commit/adb93121fc0d4790e949f79eec1c375af207bf13) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Tidy up wake-up and re-enqueue controls

## 4.0.1-beta.26

### Patch Changes

- [#747](https://github.com/vercel/workflow/pull/747) [`3fb57e1`](https://github.com/vercel/workflow/commit/3fb57e14c8bd3948599625bdf911b88db5842320) Thanks [@pranaygp](https://github.com/pranaygp)! - Use env variables instead of query params for world config (like WORKFLOW_TARGET_WORLD)

  **BREAKING CHANGE**: The OSS web UI is now locked to a single world and will not let you change world using query params

## 4.0.1-beta.25

### Patch Changes

- [#751](https://github.com/vercel/workflow/pull/751) [`dd3db13`](https://github.com/vercel/workflow/commit/dd3db13d5498622284ed97c1a273d2942478b167) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Remove the unused paused/resumed run events and states
  - Remove `run_paused` and `run_resumed` event types
  - Remove `paused` status from `WorkflowRunStatus`
  - Remove `PauseWorkflowRunParams` and `ResumeWorkflowRunParams` types
  - Remove `pauseWorkflowRun` and `resumeWorkflowRun` functions from world-vercel

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
