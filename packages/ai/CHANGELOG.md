# @workflow/ai

## 5.0.0-beta.2

### Patch Changes

- [#1769](https://github.com/vercel/workflow/pull/1769) [`5a42964`](https://github.com/vercel/workflow/commit/5a4296412f151c255a8d08c8870e511222c7c472) Thanks [@tomdale](https://github.com/tomdale)! - Embed source content in published sourcemaps.

- [#1707](https://github.com/vercel/workflow/pull/1707) [`86ebe9f`](https://github.com/vercel/workflow/commit/86ebe9fe9f17d36819bafef427a51f81e6045307) Thanks [@craze3](https://github.com/craze3)! - Preserve malformed streamed tool-call input until repair hooks can run

- [#1759](https://github.com/vercel/workflow/pull/1759) [`173756d`](https://github.com/vercel/workflow/commit/173756dc4d097fd90432e2c38c91ce1b959a6352) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Rename `useworkflow.dev` URLs to `workflow-sdk.dev`

- Updated dependencies [[`5a42964`](https://github.com/vercel/workflow/commit/5a4296412f151c255a8d08c8870e511222c7c472), [`173756d`](https://github.com/vercel/workflow/commit/173756dc4d097fd90432e2c38c91ce1b959a6352)]:
  - @workflow/serde@5.0.0-beta.1
  - workflow@5.0.0-beta.2

## 5.0.0-beta.1

### Patch Changes

- [#1663](https://github.com/vercel/workflow/pull/1663) [`4d31619`](https://github.com/vercel/workflow/commit/4d31619eb724bf243b9775ef71a34f20668a9e2a) Thanks [@gr2m](https://github.com/gr2m)! - fix(ai): preserve provider tool identity across step boundaries

  Provider tools (e.g. `anthropic.tools.webSearch`) were being converted to plain function tools in `toolsToModelTools`, stripping `type: 'provider'`, `id`, and `args`. This caused providers like Anthropic Gateway to not recognize them as provider-executed tools.

- Updated dependencies [[`c6b630f`](https://github.com/vercel/workflow/commit/c6b630fc07335e1439752fc4f1122625515d17ce), [`71d39d2`](https://github.com/vercel/workflow/commit/71d39d2f8d5739c22fb9d777e70d003b07d05987), [`0a86de3`](https://github.com/vercel/workflow/commit/0a86de3afd1b51efff32e1c3cefd7f384d1b2d8d)]:
  - workflow@5.0.0-beta.1

## 5.0.0-beta.0

### Major Changes

- [#1642](https://github.com/vercel/workflow/pull/1642) [`c5cdfc0`](https://github.com/vercel/workflow/commit/c5cdfc00751c5bef36c4be748d819081b934fbcd) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Initial v5 beta release

### Patch Changes

- Updated dependencies [[`c5cdfc0`](https://github.com/vercel/workflow/commit/c5cdfc00751c5bef36c4be748d819081b934fbcd)]:
  - @workflow/serde@5.0.0-beta.0
  - workflow@5.0.0-beta.0

## 4.1.0-beta.61

### Patch Changes

- [#1444](https://github.com/vercel/workflow/pull/1444) [`e9ebe8f`](https://github.com/vercel/workflow/commit/e9ebe8faa3da673481a699d01c29a1726f15b042) Thanks [@gr2m](https://github.com/gr2m)! - Preserve reasoning content in DurableAgent conversation history across tool loop steps

- [#1608](https://github.com/vercel/workflow/pull/1608) [`70e89bf`](https://github.com/vercel/workflow/commit/70e89bfc96ef96f88a2534c2eae0f93c3745188d) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - DurableAgent telemetry: emit full AI SDK-compatible attributes on spans

- Updated dependencies []:
  - workflow@4.2.0-beta.78

## 4.1.0-beta.60

### Patch Changes

- [#1589](https://github.com/vercel/workflow/pull/1589) [`c0f07a9`](https://github.com/vercel/workflow/commit/c0f07a985cbbc5e122ca9e0a6c73de87ddf356b9) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix fatal stream errors surfacing as `[object Object]` instead of real error messages

- Updated dependencies []:
  - workflow@4.2.0-beta.76

## 4.1.0-beta.59

### Patch Changes

- [#1529](https://github.com/vercel/workflow/pull/1529) [`a0a7195`](https://github.com/vercel/workflow/commit/a0a71957efe83a6e6223dd7c7c64a1bb65b9dabe) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix `WorkflowChatTransport` blocking browser paint during stream reconnect by yielding to the macrotask queue between chunks

- Updated dependencies []:
  - workflow@4.2.0-beta.74

## 4.1.0-beta.58

### Patch Changes

- [#1489](https://github.com/vercel/workflow/pull/1489) [`90ea870`](https://github.com/vercel/workflow/commit/90ea870adda801c3649add7a5816712e51a129b2) Thanks [@openharness](https://github.com/apps/openharness)! - Allow `experimental_context` to be configured on `DurableAgentOptions` and used as the default context for `stream()` calls.

- [#1488](https://github.com/vercel/workflow/pull/1488) [`e4e0140`](https://github.com/vercel/workflow/commit/e4e0140482c8cdb12fcb24bbed8be8fa907def4f) Thanks [@openharness](https://github.com/apps/openharness)! - Expose configured tools on `DurableAgent` instances via `agent.tools`

- [#1470](https://github.com/vercel/workflow/pull/1470) [`01bbe66`](https://github.com/vercel/workflow/commit/01bbe66d5a60d50d71f5b1c82b002ca7fc6f8e0b) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add `getStreamChunks()` and `getStreamInfo()` to the Streamer interface, and `getTailIndex()` to the readable stream returned by `run.getReadable()`. `WorkflowChatTransport` now reads the `x-workflow-stream-tail-index` response header to resolve negative `initialStartIndex` values into absolute positions, fixing reconnection retries after a disconnect.

- Updated dependencies [[`2ef33d2`](https://github.com/vercel/workflow/commit/2ef33d2828ac06debf04ad9cc239d70fea6a8093), [`aee035f`](https://github.com/vercel/workflow/commit/aee035f94483ef3b842bb557e8c5b167dd0536c4)]:
  - workflow@4.2.0-beta.72

## 4.1.0-beta.57

### Minor Changes

- [#1362](https://github.com/vercel/workflow/pull/1362) [`74aea7b`](https://github.com/vercel/workflow/commit/74aea7b0af51a959b3e6efcc3c8e082ad14e86d4) Thanks [@pranaygp](https://github.com/pranaygp)! - **BREAKING CHANGE**: Migrate to AI SDK v6. Drop AI SDK v5 support.
  - Migrate all types from V2 to V3 (`LanguageModelV2*` → `LanguageModelV3*`)
  - Update peer dependency: `ai` `^5 || ^6` → `^6`, `@ai-sdk/provider` `^2 || ^3` → `^3`
  - Simplify `CompatibleLanguageModel` from V2|V3 union to `LanguageModelV3`
  - Remove `providerExecuted` guard on tool-result stream parts (V3: all tool-results are provider-executed)
  - Add `instructions` constructor option (replaces deprecated `system`)
  - Add `onStepFinish` and `onFinish` on constructor (merged with stream callbacks)
  - Add `timeout` stream option
  - Enrich `onFinish` event with `text`, `finishReason`, `totalUsage`
  - Add `@workflow/ai/test` export with `mockTextModel` and `mockSequenceModel` for workflow e2e testing
  - Update `OutputSpecification` to match AI SDK v6 Output interface
  - Fix `WorkflowChatTransport` to forward `body` and `headers` from `ChatRequestOptions` to `prepareSendMessagesRequest` and the default request body

### Patch Changes

- [#1385](https://github.com/vercel/workflow/pull/1385) [`2c80ec7`](https://github.com/vercel/workflow/commit/2c80ec721765e84592ca92ae12ff015f37179bfd) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add type helpers (`InferDurableAgentTools`, `InferDurableAgentUIMessage`), support `prepareStep` on `DurableAgent` constructor, fix `supportedUrls` causing `AI_DownloadError` for image URLs, and add telemetry span support for `experimental_telemetry`. Fix `LanguageModelV3ToolResultOutput` breaking response when not json compatible.

- [#1389](https://github.com/vercel/workflow/pull/1389) [`4a298b5`](https://github.com/vercel/workflow/commit/4a298b506891ef90bca3fe12a118d7d0891eec66) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix `prepareStep` system message being discarded when `messages` is also returned

- Updated dependencies [[`dcb0761`](https://github.com/vercel/workflow/commit/dcb07617be46b83ce74a4932bf121b20cd3de597)]:
  - workflow@4.2.0-beta.71

## 4.0.1-beta.56

### Patch Changes

- [#1329](https://github.com/vercel/workflow/pull/1329) [`6d45c8e`](https://github.com/vercel/workflow/commit/6d45c8ec36990be55f5a8435992bf7efd01cb0c9) Thanks [@pranaygp](https://github.com/pranaygp)! - Support client-side tools in DurableAgent. Tools without an `execute` function now pause the agent loop and return `clientToolCalls` in the result instead of throwing an error.

- Updated dependencies []:
  - workflow@4.2.0-beta.69

## 4.0.1-beta.55

### Patch Changes

- [#1320](https://github.com/vercel/workflow/pull/1320) [`b28a5fd`](https://github.com/vercel/workflow/commit/b28a5fd0be591d88a38e8f9556d8bd44f927ff2f) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Use `workspace:^` for the `workflow` peer dependency so that pnpm resolves the correct version range at publish time, fixing `changeset version` warnings about mismatched dependency versions.

- Updated dependencies []:
  - workflow@4.2.0-beta.68

## 4.0.1-beta.54

### Patch Changes

- [#1212](https://github.com/vercel/workflow/pull/1212) [`eea4a02`](https://github.com/vercel/workflow/commit/eea4a02f77a85307545d059c2ced57983303a63f) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Convert tool call errors to error-text results, allowing the agent to recover from tool call failures

- [#1217](https://github.com/vercel/workflow/pull/1217) [`e55c636`](https://github.com/vercel/workflow/commit/e55c63678b15b6687cc77efca705ee9fb40fabc3) Thanks [@pranaygp](https://github.com/pranaygp)! - Upgrade dependencies across all packages

- [#1199](https://github.com/vercel/workflow/pull/1199) [`905b94a`](https://github.com/vercel/workflow/commit/905b94ac12bdedbeebc44b941c23e25a5ed02968) Thanks [@gsathya](https://github.com/gsathya)! - Pass AbortSignal option into WorkflowChatTransport reconnect handler, allowing it to prevent reconnection.

- Updated dependencies [[`e55c636`](https://github.com/vercel/workflow/commit/e55c63678b15b6687cc77efca705ee9fb40fabc3)]:
  - workflow@4.1.0-beta.62

## 4.0.1-beta.53

### Patch Changes

- [#1023](https://github.com/vercel/workflow/pull/1023) [`c8c98fe`](https://github.com/vercel/workflow/commit/c8c98fe463f4c8622988a2a9ff06a0234cb46a16) Thanks [@rovo89](https://github.com/rovo89)! - Pass optional request metadata through `WorkflowChatTransport`

- [#889](https://github.com/vercel/workflow/pull/889) [`71d09c5`](https://github.com/vercel/workflow/commit/71d09c57f2d6deca847d8f8c19fb73b065e96093) Thanks [@michael-han-dev](https://github.com/michael-han-dev)! - strip OpenAI itemId from providerMetadata to fix Responses API tool call errors

- Updated dependencies []:
  - workflow@4.1.0-beta.61

## 4.0.1-beta.52

### Patch Changes

- [#734](https://github.com/vercel/workflow/pull/734) [`8e87b24`](https://github.com/vercel/workflow/commit/8e87b24f7d7c49bd86487dff4442668aa5366533) Thanks [@pranaygp](https://github.com/pranaygp)! - Support provider-executed tools (e.g., googleSearch, WebSearch)

- [#862](https://github.com/vercel/workflow/pull/862) [`347ffbc`](https://github.com/vercel/workflow/commit/347ffbcabaef1ce5e752cfb16954de1c351f1cb3) Thanks [@gdaybrice](https://github.com/gdaybrice)! - Fix double-serialization of tool output in writeToolOutputToUI. The function was JSON.stringify-ing the entire LanguageModelV2ToolResultPart object instead of extracting the actual tool output value.

- Updated dependencies [[`50f50f4`](https://github.com/vercel/workflow/commit/50f50f44d79a3cf1102173ff1865cd8a01723ea3), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`409972e`](https://github.com/vercel/workflow/commit/409972e3b478e51972e17cb1ef6057f6a5b32c47)]:
  - workflow@4.1.0-beta.51

## 4.0.1-beta.51

### Patch Changes

- Updated dependencies []:
  - workflow@4.0.1-beta.50

## 4.0.1-beta.50

### Patch Changes

- Updated dependencies []:
  - workflow@4.0.1-beta.49

## 4.0.1-beta.49

### Patch Changes

- [#784](https://github.com/vercel/workflow/pull/784) [`f491237`](https://github.com/vercel/workflow/commit/f491237e1ed9a0054604b48ed8715dd27edf92c0) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix `collectUIMessages` option failing in workflow context

## 4.0.1-beta.48

### Patch Changes

- [#790](https://github.com/vercel/workflow/pull/790) [`49a1c5f`](https://github.com/vercel/workflow/commit/49a1c5f2fc1c6726eaed8ed77cbe47010e23c446) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Avoid attempting to serialize the "tool" during tool call execution

- Updated dependencies []:
  - workflow@4.0.1-beta.48

## 4.0.1-beta.47

### Patch Changes

- Updated dependencies []:
  - workflow@4.0.1-beta.47

## 4.0.1-beta.46

### Patch Changes

- [#768](https://github.com/vercel/workflow/pull/768) [`49bb48a`](https://github.com/vercel/workflow/commit/49bb48a25610c37da0e42e3b2c7aa07d9675688a) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Accumulate and return `uiMessages: UIMessage[]` from DurableAgent's `agent.stream`. This allows persisting messages without having to read the run's stream.

- Updated dependencies [[`7906429`](https://github.com/vercel/workflow/commit/7906429541672049821ec8b74452c99868db6290)]:
  - workflow@4.0.1-beta.46

## 4.0.1-beta.45

### Patch Changes

- Updated dependencies []:
  - workflow@4.0.1-beta.45

## 4.0.1-beta.44

### Patch Changes

- Updated dependencies []:
  - workflow@4.0.1-beta.44

## 4.0.1-beta.43

### Patch Changes

- [#733](https://github.com/vercel/workflow/pull/733) [`4b43186`](https://github.com/vercel/workflow/commit/4b43186eeca64548d351a20b5845865086393960) Thanks [@pranaygp](https://github.com/pranaygp)! - fix: preserve providerMetadata in multi-turn tool calls for Gemini thinking models

- Updated dependencies []:
  - workflow@4.0.1-beta.43

## 4.0.1-beta.42

### Patch Changes

- Updated dependencies [[`01f59a3`](https://github.com/vercel/workflow/commit/01f59a3b960070e2e42804b259b6d789a9ea6789)]:
  - workflow@4.0.1-beta.42

## 4.0.1-beta.41

### Patch Changes

- [#714](https://github.com/vercel/workflow/pull/714) [`a531a74`](https://github.com/vercel/workflow/commit/a531a740094339ea7074b3f4145f9ce9e588adb6) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Revert exporting `DurableAgent` from the root "@workflow/ai" package

- Updated dependencies []:
  - workflow@4.0.1-beta.41

## 4.0.1-beta.40

### Patch Changes

- Updated dependencies [[`307f4b0`](https://github.com/vercel/workflow/commit/307f4b0e41277f6b32afbfa361d8c6ca1b3d7f6c)]:
  - workflow@4.0.1-beta.40

## 4.0.1-beta.39

### Patch Changes

- Updated dependencies []:
  - workflow@4.0.1-beta.39

## 4.0.1-beta.38

### Patch Changes

- [#695](https://github.com/vercel/workflow/pull/695) [`25bfa52`](https://github.com/vercel/workflow/commit/25bfa52d02d8c5bb677a7effcb993d107f6ad130) Thanks [@ctate](https://github.com/ctate)! - Fix: Handle object-style finishReason for AI SDK v5/v6 compatibility

- Updated dependencies []:
  - workflow@4.0.1-beta.38

## 4.0.1-beta.37

### Patch Changes

- [#692](https://github.com/vercel/workflow/pull/692) [`b97b87b`](https://github.com/vercel/workflow/commit/b97b87b4fe4e6577ce65621de59878bb6bc2befb) Thanks [@ctate](https://github.com/ctate)! - Add support for AI SDK v6

- Updated dependencies []:
  - workflow@4.0.1-beta.37

## 4.0.1-beta.36

### Patch Changes

- [#668](https://github.com/vercel/workflow/pull/668) [`26d9769`](https://github.com/vercel/workflow/commit/26d9769335707985bddbb521d8f8e31bef7fe5ec) Thanks [@ctate](https://github.com/ctate)! - Improved AI SDK parity for `DurableAgent`

- Updated dependencies [[`8ba8b6b`](https://github.com/vercel/workflow/commit/8ba8b6be6b62c549bd6743a1e5eb96feee93b4d5)]:
  - workflow@4.0.1-beta.36

## 4.0.1-beta.35

### Patch Changes

- Updated dependencies []:
  - workflow@4.0.1-beta.35

## 4.0.1-beta.34

### Patch Changes

- Updated dependencies []:
  - workflow@4.0.1-beta.34

## 4.0.1-beta.33

### Patch Changes

- Updated dependencies []:
  - workflow@4.0.1-beta.33

## 4.0.1-beta.32

### Patch Changes

- Updated dependencies []:
  - workflow@4.0.1-beta.32

## 4.0.1-beta.31

### Patch Changes

- Updated dependencies []:
  - workflow@4.0.1-beta.31

## 4.0.1-beta.30

### Patch Changes

- [#586](https://github.com/vercel/workflow/pull/586) [`a4b67a9`](https://github.com/vercel/workflow/commit/a4b67a9b3aa0130785e6376fbeb636ca3c39b3a1) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Show a conversation view in the trace viewer UI for `doStreamStep` steps from DurableAgent

- Updated dependencies []:
  - workflow@4.0.1-beta.30

## 4.0.1-beta.29

### Patch Changes

- Updated dependencies []:
  - workflow@4.0.1-beta.29

## 4.0.1-beta.28

### Patch Changes

- workflow@4.0.1-beta.28

## 4.0.1-beta.27

### Patch Changes

- workflow@4.0.1-beta.27

## 4.0.1-beta.26

### Patch Changes

- workflow@4.0.1-beta.26

## 4.0.1-beta.25

### Patch Changes

- workflow@4.0.1-beta.25

## 4.0.1-beta.24

### Patch Changes

- workflow@4.0.1-beta.24

## 4.0.1-beta.23

### Patch Changes

- 172e015: Add AI provider step wrapper functions
- Updated dependencies [1ac5592]
  - workflow@4.0.1-beta.23

## 4.0.1-beta.22

### Patch Changes

- 17904fc: Add `prepareStep` argument for DurableAgent to modify messages between AI loop steps
- 17904fc: Make current messages state available to tool calls
- Updated dependencies [6dd1750]
  - workflow@4.0.1-beta.22

## 4.0.1-beta.21

### Patch Changes

- aba5264: Add `onStepFinish` callback to `DurableAgent#stream()`
  - workflow@4.0.1-beta.21

## 4.0.1-beta.20

### Patch Changes

- 00e3345: Make `DurableAgent#stream()` return a `messages` array
  - workflow@4.0.1-beta.20

## 4.0.1-beta.19

### Patch Changes

- workflow@4.0.1-beta.19

## 4.0.1-beta.18

### Patch Changes

- 43a3f79: DurableAgent#stream now sends `start` and `finish` chunks properly at the start and end
- 154670a: Fix `DurableAgent` to propagate `FatalError` in tool calls
- 1e636e1: Make `writable` property be required in `DurableAgent#stream()`
  - workflow@4.0.1-beta.18

## 4.0.1-beta.17

### Patch Changes

- workflow@4.0.1-beta.17

## 4.0.1-beta.16

### Patch Changes

- workflow@4.0.1-beta.16

## 4.0.1-beta.15

### Patch Changes

- 566681a: Add stopCondition argument to DurableAgent and emit error parts to writeable stream
  - workflow@4.0.1-beta.15

## 4.0.1-beta.14

### Patch Changes

- 45b7b41: Add support for defining `model` as a step function initializer
- 23f5c1d: Make `tools` optional in DurableAgent
- Updated dependencies [b97b6bf]
- Updated dependencies [6419962]
- Updated dependencies [9335026]
  - workflow@4.0.1-beta.14

## 4.0.1-beta.13

### Patch Changes

- Updated dependencies [94d46d4]
  - workflow@4.0.1-beta.13

## 4.0.1-beta.12

### Patch Changes

- Updated dependencies [fb8153b]
  - workflow@4.0.1-beta.12

## 4.0.1-beta.11

### Patch Changes

- workflow@4.0.1-beta.11

## 4.0.1-beta.10

### Patch Changes

- workflow@4.0.1-beta.10

## 4.0.1-beta.9

### Patch Changes

- Updated dependencies [8a24093]
  - workflow@4.0.1-beta.9

## 4.0.1-beta.8

### Patch Changes

- 9e1ab0a: Add `preventClose` option to prevent closing writable after agent.stream
- Updated dependencies [05714f7]
- Updated dependencies [f563585]
  - workflow@4.0.1-beta.8

## 4.0.1-beta.7

### Patch Changes

- f973954: Update license to Apache 2.0
- Updated dependencies [f973954]
- Updated dependencies [fcadd7b]
  - workflow@4.0.1-beta.7

## 4.0.1-beta.6

### Patch Changes

- 577d212: Use instance API endpoint in WorkflowChatTransport
- Updated dependencies [70be894]
  - workflow@4.0.1-beta.6

## 4.0.1-beta.5

### Patch Changes

- workflow@4.0.1-beta.5

## 4.0.1-beta.4

### Patch Changes

- workflow@4.0.1-beta.4

## 4.0.1-beta.3

### Patch Changes

- Updated dependencies [7dad974]
  - workflow@4.0.1-beta.3

## 4.0.1-beta.2

### Patch Changes

- workflow@4.0.1-beta.2

## 4.0.1-beta.1

### Patch Changes

- 1408293: Add "description" field to `package.json` file
- 8422a32: Update Workflow naming convention
- e46294f: Add "license" and "repository" fields to `package.json` file
- Updated dependencies [1408293]
- Updated dependencies [cea8530]
- Updated dependencies [e46294f]
  - workflow@4.0.1-beta.1

## 4.0.1-beta.0

### Patch Changes

- fcf63d0: Initial publish
- Updated dependencies [fcf63d0]
  - workflow@4.0.1-beta.0
