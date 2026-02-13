# @workflow/web-shared

## 4.1.0-beta.52

### Patch Changes

- Updated dependencies []:
  - @workflow/core@4.1.0-beta.57

## 4.1.0-beta.51

### Patch Changes

- [#1015](https://github.com/vercel/workflow/pull/1015) [`c56dc38`](https://github.com/vercel/workflow/commit/c56dc3848ecf3e188f876dc4cb7861df185bd4fb) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Extract browser-safe serialization format from `@workflow/core` and split o11y hydration by environment. Data hydration now happens client-side in the browser, enabling future e2e encryption support.

- [#1017](https://github.com/vercel/workflow/pull/1017) [`4938b24`](https://github.com/vercel/workflow/commit/4938b2467447677cfc9b3ffeef8f20091e4398fb) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Render the detail panel outside the trace viewer context so hydrated data no longer passes through the web worker's `postMessage` boundary. Fixes `URLSearchParams object could not be cloned` errors.

- [#1018](https://github.com/vercel/workflow/pull/1018) [`8a53c3f`](https://github.com/vercel/workflow/commit/8a53c3fa3d31ef98a3715680f919fed499ecfba3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Replace JSON.stringify-based data rendering with `react-inspector` ObjectInspector for proper display of Map, Set, URLSearchParams, Date, Error, RegExp, typed arrays, and other non-plain-object types.

- Updated dependencies [[`c56dc38`](https://github.com/vercel/workflow/commit/c56dc3848ecf3e188f876dc4cb7861df185bd4fb), [`d7d005b`](https://github.com/vercel/workflow/commit/d7d005b54b621214720518a2a19aa2cadfa23d47), [`8d117cd`](https://github.com/vercel/workflow/commit/8d117cd219faac53ffa90db8628defd3d7a8160d), [`63caf93`](https://github.com/vercel/workflow/commit/63caf931380b8211f1948cf44eac7532f33e660d), [`dc2dc6a`](https://github.com/vercel/workflow/commit/dc2dc6ac7908e57be9ab34140addfe98a9246fc7)]:
  - @workflow/core@4.1.0-beta.56

## 4.1.0-beta.50

### Patch Changes

- Updated dependencies [[`3d770d5`](https://github.com/vercel/workflow/commit/3d770d53855ce7c8522d4f0afbdbc123eae6c1ee), [`a5935ab`](https://github.com/vercel/workflow/commit/a5935abec7c7e57b2a89c629203d567cd7ac76a7), [`fc4cad6`](https://github.com/vercel/workflow/commit/fc4cad68088b0f4fa4e5eeb828e2af29e05d4fe1), [`56f2221`](https://github.com/vercel/workflow/commit/56f22219b338a5a2c29466798a5ad36a6a450498)]:
  - @workflow/utils@4.1.0-beta.12
  - @workflow/core@4.1.0-beta.55
  - @workflow/world@4.1.0-beta.4

## 4.1.0-beta.49

### Patch Changes

- [#951](https://github.com/vercel/workflow/pull/951) [`f7fd88e`](https://github.com/vercel/workflow/commit/f7fd88ea963e127e62c8d527dcfdb895ba646fc2) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Tidy health check latency calculation

- Updated dependencies [[`fcfaf8b`](https://github.com/vercel/workflow/commit/fcfaf8bbaa912b1767c646592e539d5f98cd1e9c), [`d9e9859`](https://github.com/vercel/workflow/commit/d9e98590fae17fd090e0be4f0b54bbaa80c7be69), [`f7fd88e`](https://github.com/vercel/workflow/commit/f7fd88ea963e127e62c8d527dcfdb895ba646fc2)]:
  - @workflow/core@4.1.0-beta.54
  - @workflow/world@4.1.0-beta.3

## 4.1.0-beta.48

### Patch Changes

- [#927](https://github.com/vercel/workflow/pull/927) [`f090de1`](https://github.com/vercel/workflow/commit/f090de1eb48ad8ec3fd776e9d084310d56a7ac29) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Added subpatch exports for runtime modules to allow direct imports in core. Refactored web-shared to be a thin package that exported UI components and world-actions. Updated web package to consume the UI components and world-actions from web-shared.

- Updated dependencies [[`0ce46b9`](https://github.com/vercel/workflow/commit/0ce46b91d9c8ca3349f43cdf3a5d75a948d6f5ad), [`f090de1`](https://github.com/vercel/workflow/commit/f090de1eb48ad8ec3fd776e9d084310d56a7ac29), [`79e988f`](https://github.com/vercel/workflow/commit/79e988fa85f0ebdd5c8913b8de84e01c55d020b9), [`c54ba21`](https://github.com/vercel/workflow/commit/c54ba21c19040577ed95f6264a2670f190e1d1d3), [`e0061b8`](https://github.com/vercel/workflow/commit/e0061b861d0e3c3dc15853aed331fb1bbab71408), [`38e8d55`](https://github.com/vercel/workflow/commit/38e8d5571d2ee4b80387943f8f39a93b6e4bc751), [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6), [`efb33b2`](https://github.com/vercel/workflow/commit/efb33b2b5edf6ccb1ec2f02f1d99f2a009333780), [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6)]:
  - @workflow/world@4.1.0-beta.2
  - @workflow/core@4.1.0-beta.53

## 4.1.0-beta.47

### Patch Changes

- Updated dependencies [[`e4e3281`](https://github.com/vercel/workflow/commit/e4e32812f8f181ad4db72e76f62ba1edf2477b12)]:
  - @workflow/core@4.1.0-beta.52

## 4.1.0-beta.46

### Minor Changes

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - **BREAKING**: Storage interface is now read-only; all mutations go through `events.create()`
  - Remove `cancel`, `pause`, `resume` from `runs`
  - Remove `create`, `update` from `runs`, `steps`, `hooks`
  - Add run lifecycle events: `run_created`, `run_started`, `run_completed`, `run_failed`, `run_cancelled`
  - Add `step_created` event type
  - Remove `fatal` field from `step_failed` (terminal failure is now implicit)
  - Add `step_retrying` event with error info for retriable failures

### Patch Changes

- [#894](https://github.com/vercel/workflow/pull/894) [`a2b688d`](https://github.com/vercel/workflow/commit/a2b688d0623ebbae117877a696c5b9b288d628fd) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix resuming v1 hooks and cancelling/re-running v1 runs from a v2 UI or runtime

- [#869](https://github.com/vercel/workflow/pull/869) [`24ca465`](https://github.com/vercel/workflow/commit/24ca46586940fc48bb993ecde03e595d1471895d) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Allow recreateRun to accept an optional deploymentId parameter

- [#814](https://github.com/vercel/workflow/pull/814) [`b16a682`](https://github.com/vercel/workflow/commit/b16a6828af36a2d5adb38fb6a6d1253657001ac8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Move "parse-name" into the `utils` package

- [#833](https://github.com/vercel/workflow/pull/833) [`bd8116d`](https://github.com/vercel/workflow/commit/bd8116d40bf8d662537bf015d2861f6d1768d69e) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Remove `skipProxy` and `baseUrl` config options, simplify proxy logic

- [#853](https://github.com/vercel/workflow/pull/853) [`1060f9d`](https://github.com/vercel/workflow/commit/1060f9d04a372bf6de6c5c3d52063bcc22dba6e8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - **BREAKING CHANGE**: Change user input/output to be binary data (Uint8Array) at the World interface

  This is part of specVersion 2 changes where serialization of workflow and step data uses binary format instead of JSON arrays. This allows the workflow client to be fully responsible for the data serialization format and enables future enhancements such as encryption and compression without the World implementation needing to care about the underlying data representation.

- [#891](https://github.com/vercel/workflow/pull/891) [`0aa50e5`](https://github.com/vercel/workflow/commit/0aa50e5ca4f760540536d54c0b517509272fc357) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Add missing 'use client' directives to client components

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - Remove deprecated `workflow_completed`, `workflow_failed`, and `workflow_started` events in favor of `run_completed`, `run_failed`, and `run_started` events.

- [#856](https://github.com/vercel/workflow/pull/856) [`f64b776`](https://github.com/vercel/workflow/commit/f64b7761657c46978bcb0df80e0bfc768f2b8a10) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Style the resolve hook modal for theme tokens and align the cancel action with secondary button styling.

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - Add `specVersion` property to World interface
  - All worlds expose `@workflow/world` package version for protocol compatibility
  - Stored in `run_created` event and `WorkflowRun` schema
  - Displayed in observability UI

- [#868](https://github.com/vercel/workflow/pull/868) [`c45bc3f`](https://github.com/vercel/workflow/commit/c45bc3fd15ca201ee568cf7789ff1467cf7ba566) Thanks [@pranaygp](https://github.com/pranaygp)! - Add SDK version to workflow run executionContext for observability

- Updated dependencies [[`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`26a9833`](https://github.com/vercel/workflow/commit/26a98330d478dd76192d9897b5a0cc0cf3feacd7), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`b59559b`](https://github.com/vercel/workflow/commit/b59559be70e839025680c4f9873d521170e48e1c), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`a2b688d`](https://github.com/vercel/workflow/commit/a2b688d0623ebbae117877a696c5b9b288d628fd), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`1f684df`](https://github.com/vercel/workflow/commit/1f684df6b7b9cd322d5f1aa4a70dcaa3e07c7986), [`b16a682`](https://github.com/vercel/workflow/commit/b16a6828af36a2d5adb38fb6a6d1253657001ac8), [`bd8116d`](https://github.com/vercel/workflow/commit/bd8116d40bf8d662537bf015d2861f6d1768d69e), [`1060f9d`](https://github.com/vercel/workflow/commit/1060f9d04a372bf6de6c5c3d52063bcc22dba6e8), [`00c7961`](https://github.com/vercel/workflow/commit/00c7961ecb09418d6c23e1346a1b6569eb66a6bf), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`b973b8d`](https://github.com/vercel/workflow/commit/b973b8d00f6459fa675ee9875642e49760f68879), [`c45bc3f`](https://github.com/vercel/workflow/commit/c45bc3fd15ca201ee568cf7789ff1467cf7ba566), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae)]:
  - @workflow/world@4.1.0-beta.1
  - @workflow/errors@4.1.0-beta.14
  - @workflow/world-vercel@4.1.0-beta.29
  - @workflow/core@4.1.0-beta.51
  - @workflow/utils@4.1.0-beta.11

## 4.0.1-beta.45

### Patch Changes

- [#816](https://github.com/vercel/workflow/pull/816) [`5ba82ec`](https://github.com/vercel/workflow/commit/5ba82ec4b105d11538be6ad65449986eaf945916) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add button to run queue based health checks

- [#828](https://github.com/vercel/workflow/pull/828) [`549ffbe`](https://github.com/vercel/workflow/commit/549ffbee3c75396f7d4362558c957101f59ce400) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Tone down color use on event list view

- Updated dependencies [[`5ba82ec`](https://github.com/vercel/workflow/commit/5ba82ec4b105d11538be6ad65449986eaf945916), [`f3785f0`](https://github.com/vercel/workflow/commit/f3785f04fbdf9e6199e0e42c592e3d5ba246a6c6)]:
  - @workflow/core@4.0.1-beta.41
  - @workflow/world-vercel@4.0.1-beta.28

## 4.0.1-beta.44

### Patch Changes

- [#805](https://github.com/vercel/workflow/pull/805) [`4247c72`](https://github.com/vercel/workflow/commit/4247c727b0e8f51b19b8f13f8636e378ddf82e64) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Improve styling, error display, and scroll behavior of trace viewer sidebar

- [#809](https://github.com/vercel/workflow/pull/809) [`f93e894`](https://github.com/vercel/workflow/commit/f93e894a6a95a194637dc2ea8b19e1ad0b7653eb) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Show custom class serialization UI and class names in o11y

- [#806](https://github.com/vercel/workflow/pull/806) [`d30e5c0`](https://github.com/vercel/workflow/commit/d30e5c0249018083bdd63ac84408449003399099) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - [web] Add view to display a list of all events

- Updated dependencies [[`1843704`](https://github.com/vercel/workflow/commit/1843704b83d5aaadcf1e4f5f1c73c150bd0bd2a3), [`f93e894`](https://github.com/vercel/workflow/commit/f93e894a6a95a194637dc2ea8b19e1ad0b7653eb)]:
  - @workflow/core@4.0.1-beta.40

## 4.0.1-beta.43

### Patch Changes

- [#788](https://github.com/vercel/workflow/pull/788) [`b729d49`](https://github.com/vercel/workflow/commit/b729d49610739ae818fd56853f8ddc557591e9a1) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Ensure re-running Run from o11y UI will use specified world, instead of inferring from env

- Updated dependencies [[`344c90f`](https://github.com/vercel/workflow/commit/344c90ff9f630addc4b41f72c2296b26e61513bc), [`b729d49`](https://github.com/vercel/workflow/commit/b729d49610739ae818fd56853f8ddc557591e9a1)]:
  - @workflow/core@4.0.1-beta.39

## 4.0.1-beta.42

### Patch Changes

- [#774](https://github.com/vercel/workflow/pull/774) [`abdca8f`](https://github.com/vercel/workflow/commit/abdca8fd526f3c83c7da7b96a0522f9552e2bd2f) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Improve display of configuration information. Fix opening of Vercel backend when using `--localUi`. Fix world caching in multi-tenant environments. Fix flicker in run table when refreshing. Improve contributor experience by adding `--observabilityCwd` flag to easily iterate on web UI from another directory. Polish navbar UI.

- [#783](https://github.com/vercel/workflow/pull/783) [`125d0a6`](https://github.com/vercel/workflow/commit/125d0a666e3bb899609c55fd6f358bc6d61463d3) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix unsafe access of requestId in UI worker for trace viewer

- [#787](https://github.com/vercel/workflow/pull/787) [`7ff6a05`](https://github.com/vercel/workflow/commit/7ff6a05cf9ffd91300b081ec1dfa9cf3cf278ed0) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Allow passing user env variables to vercel backend in o11y UI

## 4.0.1-beta.41

### Patch Changes

- Updated dependencies [[`7906429`](https://github.com/vercel/workflow/commit/7906429541672049821ec8b74452c99868db6290)]:
  - @workflow/core@4.0.1-beta.38

## 4.0.1-beta.40

### Patch Changes

- Updated dependencies [[`61fdb41`](https://github.com/vercel/workflow/commit/61fdb41e1b5cd52c7b23fa3c0f3fcaa50c4189ca), [`61fdb41`](https://github.com/vercel/workflow/commit/61fdb41e1b5cd52c7b23fa3c0f3fcaa50c4189ca), [`3dd5b27`](https://github.com/vercel/workflow/commit/3dd5b2708de56e63c9dce9b3f2eafea63b0e3936), [`0aa835f`](https://github.com/vercel/workflow/commit/0aa835fe30d4d61e2d6dcde693d6fbb24be72c66), [`49f650c`](https://github.com/vercel/workflow/commit/49f650c3a79e7b9b501cb602e3c12b75a3c4fffc), [`39e5774`](https://github.com/vercel/workflow/commit/39e5774de2a4c8b6a18574aa4edaf79e9f0d655e)]:
  - @workflow/core@4.0.1-beta.37
  - @workflow/world@4.0.1-beta.13
  - @workflow/errors@4.0.1-beta.13

## 4.0.1-beta.39

### Patch Changes

- [#747](https://github.com/vercel/workflow/pull/747) [`3fb57e1`](https://github.com/vercel/workflow/commit/3fb57e14c8bd3948599625bdf911b88db5842320) Thanks [@pranaygp](https://github.com/pranaygp)! - Use env variables instead of query params for world config (like WORKFLOW_TARGET_WORLD)

  **BREAKING CHANGE**: The OSS web UI is now locked to a single world and will not let you change world using query params

## 4.0.1-beta.38

### Patch Changes

- [#736](https://github.com/vercel/workflow/pull/736) [`0d79ff0`](https://github.com/vercel/workflow/commit/0d79ff084ce85880a11b9d056bd07c26bf68547a) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Increase contrast on attribute items in sidebar

- [#751](https://github.com/vercel/workflow/pull/751) [`dd3db13`](https://github.com/vercel/workflow/commit/dd3db13d5498622284ed97c1a273d2942478b167) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Remove the unused paused/resumed run events and states
  - Remove `run_paused` and `run_resumed` event types
  - Remove `paused` status from `WorkflowRunStatus`
  - Remove `PauseWorkflowRunParams` and `ResumeWorkflowRunParams` types
  - Remove `pauseWorkflowRun` and `resumeWorkflowRun` functions from world-vercel

- Updated dependencies [[`dd3db13`](https://github.com/vercel/workflow/commit/dd3db13d5498622284ed97c1a273d2942478b167)]:
  - @workflow/world@4.0.1-beta.12
  - @workflow/core@4.0.1-beta.36
  - @workflow/errors@4.0.1-beta.13

## 4.0.1-beta.37

### Patch Changes

- [#728](https://github.com/vercel/workflow/pull/728) [`de31837`](https://github.com/vercel/workflow/commit/de3183719c6e5bb6e6a1008a36a401e5afa27b0f) Thanks [@haydenbleasel](https://github.com/haydenbleasel)! - Upgrade Streamdown to 1.6.11

- Updated dependencies [[`4d6f797`](https://github.com/vercel/workflow/commit/4d6f797274331b2efa69576dda7361ef7f704edf)]:
  - @workflow/core@4.0.1-beta.35

## 4.0.1-beta.36

### Patch Changes

- Updated dependencies [[`9b1640d`](https://github.com/vercel/workflow/commit/9b1640d76e7e759446058d65272011071bb250d2), [`307f4b0`](https://github.com/vercel/workflow/commit/307f4b0e41277f6b32afbfa361d8c6ca1b3d7f6c)]:
  - @workflow/core@4.0.1-beta.34
  - @workflow/errors@4.0.1-beta.13

## 4.0.1-beta.35

### Patch Changes

- Updated dependencies []:
  - @workflow/core@4.0.1-beta.33

## 4.0.1-beta.34

### Patch Changes

- Updated dependencies [[`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6)]:
  - @workflow/world@4.0.1-beta.11
  - @workflow/core@4.0.1-beta.32
  - @workflow/errors@4.0.1-beta.12

## 4.0.1-beta.33

### Patch Changes

- [#674](https://github.com/vercel/workflow/pull/674) [`4bc98ff`](https://github.com/vercel/workflow/commit/4bc98ff4a15a090e2233c18b75e0a1b5dd2e9ff1) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Move ErrorBoundary component from web to web-shared and use in sidebar detail view.

- Updated dependencies [[`25b02b0`](https://github.com/vercel/workflow/commit/25b02b0bfdefa499e13fb974b1832fbe47dbde86)]:
  - @workflow/core@4.0.1-beta.31
  - @workflow/errors@4.0.1-beta.11

## 4.0.1-beta.32

### Patch Changes

- [#673](https://github.com/vercel/workflow/pull/673) [`616bc67`](https://github.com/vercel/workflow/commit/616bc67be4691830e272b4987c73f1155adc5303) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix null access in event data. This is due to a typing issue in event.eventData in the world interface, which will be resolved separately

## 4.0.1-beta.31

### Patch Changes

- [#656](https://github.com/vercel/workflow/pull/656) [`ef22f82`](https://github.com/vercel/workflow/commit/ef22f82c9ead53744bac23fa12ed6bfbb1aba0bb) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Allow resuming hooks with payloads from the UI

- [#658](https://github.com/vercel/workflow/pull/658) [`88ad5c9`](https://github.com/vercel/workflow/commit/88ad5c9bbf4d79ef89a82492145ca70f9bf7cada) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix trace viewer not showing hook spans correctly if hook was already disposed

- Updated dependencies []:
  - @workflow/core@4.0.1-beta.30

## 4.0.1-beta.30

### Patch Changes

- Updated dependencies [[`eaf9aa6`](https://github.com/vercel/workflow/commit/eaf9aa65f354bf1e22e8e148c0fd1936f0ec9358)]:
  - @workflow/core@4.0.1-beta.29

## 4.0.1-beta.29

### Patch Changes

- [#636](https://github.com/vercel/workflow/pull/636) [`c6f33ee`](https://github.com/vercel/workflow/commit/c6f33ee9d3a7889389f3ad30a30704e552dc596a) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Show event markers for step_started events

- [#623](https://github.com/vercel/workflow/pull/623) [`ce7d428`](https://github.com/vercel/workflow/commit/ce7d428a07cd415d2ea64c779b84ecdc796927a0) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Re-fetch previous steps in live trace viewer to ensure status gets updated correctly even for parallel step invocations

- [#622](https://github.com/vercel/workflow/pull/622) [`a84f0db`](https://github.com/vercel/workflow/commit/a84f0db22715644e2a08d5455b68836255826828) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Indicate time between createdAt and startedAt for runs/steps, fix when "wake up from sleep" is shown

- [#638](https://github.com/vercel/workflow/pull/638) [`4bdd3e5`](https://github.com/vercel/workflow/commit/4bdd3e5086a51a46898cca774533019d3ace77b3) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Move auth error messages into @workflow/errors package

- Updated dependencies [[`ea2a67e`](https://github.com/vercel/workflow/commit/ea2a67e19c5d224b4b4fd1c1a417810562df0807), [`712f6f8`](https://github.com/vercel/workflow/commit/712f6f86b1804c82d4cab3bba0db49584451d005), [`4bdd3e5`](https://github.com/vercel/workflow/commit/4bdd3e5086a51a46898cca774533019d3ace77b3)]:
  - @workflow/core@4.0.1-beta.28
  - @workflow/errors@4.0.1-beta.10

## 4.0.1-beta.28

### Patch Changes

- [#582](https://github.com/vercel/workflow/pull/582) [`05ea678`](https://github.com/vercel/workflow/commit/05ea6789e5773d5b4ee16dce4a800e613261f452) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add buttons to wake up workflow from sleep or scheduling issues

- Updated dependencies [[`deaf019`](https://github.com/vercel/workflow/commit/deaf0193e91ea7a24d2423a813b64f51faa681e3), [`b56aae3`](https://github.com/vercel/workflow/commit/b56aae3fe9b5568d7bdda592ed025b3499149240), [`4d7a393`](https://github.com/vercel/workflow/commit/4d7a393906846be751e798c943594bec3c9b0ff3)]:
  - @workflow/core@4.0.1-beta.27
  - @workflow/errors@4.0.1-beta.9

## 4.0.1-beta.27

### Patch Changes

- [#586](https://github.com/vercel/workflow/pull/586) [`a4b67a9`](https://github.com/vercel/workflow/commit/a4b67a9b3aa0130785e6376fbeb636ca3c39b3a1) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Show a conversation view in the trace viewer UI for `doStreamStep` steps from DurableAgent

- Updated dependencies [[`696e7e3`](https://github.com/vercel/workflow/commit/696e7e31e88eae5d86e9d4b9f0344f0777ae9673)]:
  - @workflow/core@4.0.1-beta.26
  - @workflow/errors@4.0.1-beta.8

## 4.0.1-beta.26

### Patch Changes

- [#575](https://github.com/vercel/workflow/pull/575) [`161c54c`](https://github.com/vercel/workflow/commit/161c54ca13e0c36220640e656b7abe4ff282dbb0) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add Web and CLI UI for listing and viewing streams

- [#572](https://github.com/vercel/workflow/pull/572) [`33c254c`](https://github.com/vercel/workflow/commit/33c254c82c1c452300d6bff531c33329aa01d4ec) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Refactor error handling to surface more error details and reduce code

- [#562](https://github.com/vercel/workflow/pull/562) [`058757c`](https://github.com/vercel/workflow/commit/058757c476579a7b1bb6a8ba9a3d15f57b30c898) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Unify time helper functions

- Updated dependencies [[`161c54c`](https://github.com/vercel/workflow/commit/161c54ca13e0c36220640e656b7abe4ff282dbb0), [`c82b467`](https://github.com/vercel/workflow/commit/c82b46720cf6284f3c7e3ded107e1d8321f6e705), [`0bbd26f`](https://github.com/vercel/workflow/commit/0bbd26f8c85a04dea3dc87a11c52e9ac63a18e84), [`c35b445`](https://github.com/vercel/workflow/commit/c35b4458753cc116b90d61f470f7ab1d964e8a1e), [`d3fd81d`](https://github.com/vercel/workflow/commit/d3fd81dffd87abbd1a3d8a8e91e9781959eefd40)]:
  - @workflow/core@4.0.1-beta.25
  - @workflow/world@4.0.1-beta.10
  - @workflow/errors@4.0.1-beta.7

## 4.0.1-beta.25

### Patch Changes

- 57a2c32: Add expiredAt attribute to Run
- 14daedd: Refine span viewer panel UI: reduced font sizes and spacing, added connecting lines in detail cards, improved attribute layout with bordered containers. Improve status badge with colored indicators and optional duration, add overlay mode to copyable text, simplify stream detail back navigation
- 4aecb99: Add workflow graph visualization to observability UI and o11y migration to nuqs for url state management
- 24e6271: UI polish: inline durations, font fixes, trace viewer scrolling fix
- 7969df9: Pretty-print large durations in trace viewer as days/hours/minutes/seconds instead of raw seconds
- 8172455: Show expiredAt date in trace viewer, add tooltip
- Updated dependencies [57a2c32]
  - @workflow/world@4.0.1-beta.9
  - @workflow/core@4.0.1-beta.24

## 4.0.1-beta.24

### Patch Changes

- @workflow/core@4.0.1-beta.23

## 4.0.1-beta.23

### Patch Changes

- Updated dependencies [02c41cc]
  - @workflow/core@4.0.1-beta.22

## 4.0.1-beta.22

### Patch Changes

- Updated dependencies [2f0840b]
  - @workflow/core@4.0.1-beta.21

## 4.0.1-beta.21

### Patch Changes

- Updated dependencies [0f1645b]
- Updated dependencies [10c5b91]
- Updated dependencies [bdde1bd]
- Updated dependencies [8d4562e]
  - @workflow/core@4.0.1-beta.20
  - @workflow/world@4.0.1-beta.8

## 4.0.1-beta.20

### Patch Changes

- fb9fd0f: Add support for closure scope vars in step functions
- Updated dependencies [07800c2]
- Updated dependencies [fb9fd0f]
  - @workflow/core@4.0.1-beta.19
  - @workflow/world@4.0.1-beta.7

## 4.0.1-beta.19

### Patch Changes

- @workflow/core@4.0.1-beta.18

## 4.0.1-beta.18

### Patch Changes

- @workflow/core@4.0.1-beta.17

## 4.0.1-beta.17

### Patch Changes

- 9961140: Fix hydration of eventData for sleep calls
- Updated dependencies [3436629]
- Updated dependencies [9961140]
- Updated dependencies [73b6c68]
  - @workflow/core@4.0.1-beta.16

## 4.0.1-beta.16

### Patch Changes

- Updated dependencies [3d99d6d]
  - @workflow/core@4.0.1-beta.15

## 4.0.1-beta.15

### Patch Changes

- Updated dependencies [6e41c90]
  - @workflow/core@4.0.1-beta.14

## 4.0.1-beta.14

### Patch Changes

- 4b70739: Require specifying runId when writing to stream
- Updated dependencies [2fde24e]
- Updated dependencies [4b70739]
  - @workflow/core@4.0.1-beta.13
  - @workflow/world@4.0.1-beta.6

## 4.0.1-beta.13

### Patch Changes

- 00b0bb9: Support structured error rendering
- b97b6bf: Lock all dependencies in our packages
- c1ccdc8: [web-shared] Cache world instantiation in server actions (#304)
- Updated dependencies [5eb588a]
- Updated dependencies [00b0bb9]
- Updated dependencies [85ce8e0]
- Updated dependencies [b97b6bf]
- Updated dependencies [f8e5d10]
- Updated dependencies [6be03f3]
- Updated dependencies [f07b2da]
- Updated dependencies [00b0bb9]
  - @workflow/core@4.0.1-beta.12
  - @workflow/world@4.0.1-beta.5

## 4.0.1-beta.12

### Patch Changes

- 00efdfb: Improve trace viewer load times and loading animation
- Updated dependencies [8208b53]
- Updated dependencies [aac1b6c]
- Updated dependencies [6373ab5]
  - @workflow/core@4.0.1-beta.11

## 4.0.1-beta.11

### Patch Changes

- 0b3e89e: Fix event data serialization for observability
- Updated dependencies [7013f29]
- Updated dependencies [a28bc37]
- Updated dependencies [809e0fe]
- Updated dependencies [adf0cfe]
- Updated dependencies [5c0268b]
- Updated dependencies [0b3e89e]
- Updated dependencies [7a47eb8]
  - @workflow/core@4.0.1-beta.10

## 4.0.1-beta.10

### Patch Changes

- 9755566: Increase compatibility for node16 moduleResolution when used for direct imports
- Updated dependencies [9f56434]
  - @workflow/core@4.0.1-beta.9

## 4.0.1-beta.9

### Patch Changes

- d71da4a: Update packaging to support node16-style module resolution

## 4.0.1-beta.8

### Patch Changes

- Updated dependencies [4a821fc]
  - @workflow/core@4.0.1-beta.8

## 4.0.1-beta.7

### Patch Changes

- 7db9e94: Fix hook events not displaying on trace viewer if there's multiple hook_received events
- Updated dependencies [05714f7]
  - @workflow/core@4.0.1-beta.7

## 4.0.1-beta.6

### Patch Changes

- a3326a2: Slightly improve error handling for wait event fetching in detail panel
- f973954: Update license to Apache 2.0
- 2ae7426: Export react-jsx transpiled code, not raw jsx
- Updated dependencies [10309c3]
- Updated dependencies [f973954]
  - @workflow/core@4.0.1-beta.6
  - @workflow/world@4.0.1-beta.4

## 4.0.1-beta.5

### Patch Changes

- 8f63385: Add readme section about self-hosting observability UI
- 7f5a2da: Add support for displaying new wait events
- 55e2d0b: Extract reusable web UI code into shared package
- Updated dependencies [796fafd]
- Updated dependencies [20d51f0]
- Updated dependencies [70be894]
- Updated dependencies [20d51f0]
  - @workflow/core@4.0.1-beta.5
  - @workflow/world@4.0.1-beta.3
