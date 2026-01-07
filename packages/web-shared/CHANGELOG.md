# @workflow/web-shared

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
