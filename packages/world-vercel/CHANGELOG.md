# @workflow/world-vercel

## 5.0.0-beta.12

### Patch Changes

- [#2257](https://github.com/vercel/workflow/pull/2257) [`ccd37e9`](https://github.com/vercel/workflow/commit/ccd37e9a59f1b3629815cdaf1c650610c709a580) Thanks [@pranaygp](https://github.com/pranaygp)! - Avoid unhandled run lookups for unused or empty readable streams and include Vercel request correlation headers in world transport errors.

- [#2255](https://github.com/vercel/workflow/pull/2255) [`81bda49`](https://github.com/vercel/workflow/commit/81bda490ef2726ef36ce457932ec94cc3abc6bc2) Thanks [@ctgowrie](https://github.com/ctgowrie)! - Update @vercel/queue from 0.2.1 to 0.3.0

- [#2035](https://github.com/vercel/workflow/pull/2035) [`c19f38d`](https://github.com/vercel/workflow/commit/c19f38d9071f12de3a44e8f5b5442bf9dfbebd80) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Validate ref resolve responses (empty, truncated, or `Content-Length`-mismatched bodies) before use, throwing `WorkflowWorldError` instead of corrupting the event log.

## 5.0.0-beta.11

### Minor Changes

- [#2235](https://github.com/vercel/workflow/pull/2235) [`3a16272`](https://github.com/vercel/workflow/commit/3a16272bd363d56de58c81ef4dba75b89897a749) Thanks [@AndrewBarba](https://github.com/AndrewBarba)! - Add a `dispatcher` option to `createVercelWorld` for supplying a custom undici dispatcher, used for both HTTP and queue requests. Defaults to the shared undici `RetryAgent`.

### Patch Changes

- [#2231](https://github.com/vercel/workflow/pull/2231) [`b8a337c`](https://github.com/vercel/workflow/commit/b8a337c945cc0566b5d87e4e40026f50aa8c60ff) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Update `undici` to 7.26.0.

- [#2246](https://github.com/vercel/workflow/pull/2246) [`ddc8a79`](https://github.com/vercel/workflow/commit/ddc8a79741e8d281717e9fb361cf0001af460e9b) Thanks [@ctgowrie](https://github.com/ctgowrie)! - Update `@vercel/queue` from 0.1.7 to 0.2.1

- Updated dependencies [[`2a3b11b`](https://github.com/vercel/workflow/commit/2a3b11bcb408f1aa071b0e37f0b2df614052acd1)]:
  - @workflow/errors@5.0.0-beta.7
  - @workflow/world@5.0.0-beta.7

## 5.0.0-beta.10

### Patch Changes

- [#2204](https://github.com/vercel/workflow/pull/2204) [`7994629`](https://github.com/vercel/workflow/commit/7994629b8bd0781369a4d55b7034b2b722a8c556) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Retry transient response-body read/decode failures (truncated or terminated streams, gateway non-CBOR bodies) on idempotent requests inside the HTTP client, so a sporadic `events.list` parse failure no longer surfaces as a fatal error.

- Updated dependencies [[`8f68d35`](https://github.com/vercel/workflow/commit/8f68d3525ce3e420f4d16b9976c97a5598f91afd)]:
  - @workflow/world@5.0.0-beta.6
  - @workflow/errors@5.0.0-beta.6

## 5.0.0-beta.9

### Patch Changes

- Updated dependencies [[`8d0928b`](https://github.com/vercel/workflow/commit/8d0928b2a2ce61b6c05cb8930d29f176b3a83970)]:
  - @workflow/errors@5.0.0-beta.6

## 5.0.0-beta.8

### Patch Changes

- [#2142](https://github.com/vercel/workflow/pull/2142) [`ae37315`](https://github.com/vercel/workflow/commit/ae37315cb708b413f2ee9945c90a23a57dfd410d) Thanks [@pranaygp](https://github.com/pranaygp)! - Prevent failed stream writes from surfacing as unhandled rejections and include request correlation details in stream errors.

## 5.0.0-beta.7

### Minor Changes

- [#1978](https://github.com/vercel/workflow/pull/1978) [`b0d0561`](https://github.com/vercel/workflow/commit/b0d0561afc41d20b5203c02bb9a4dbf59d18c214) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `@workflow/world-vercel/run-id` sub-export with `encode`/`decode` helpers that produce ULID-shaped workflow run IDs carrying a tag bit, a 5-bit version, and a 6-bit Vercel region ID.

### Patch Changes

- [#2134](https://github.com/vercel/workflow/pull/2134) [`1e6b1fd`](https://github.com/vercel/workflow/commit/1e6b1fdea2010c1f55b3e6fb5386d436c4406eb4) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add `experimental_setAttributes()` workflow-level helper for attaching string key/value metadata to a workflow run, surfaced as `run.attributes`

- [#1799](https://github.com/vercel/workflow/pull/1799) [`503a929`](https://github.com/vercel/workflow/commit/503a929d347df46eb0ad63b068da7781762d0dc8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Use inline sourcemaps for all workspace packages; published packages no longer ship external `.js.map` files.

- Updated dependencies [[`1e6b1fd`](https://github.com/vercel/workflow/commit/1e6b1fdea2010c1f55b3e6fb5386d436c4406eb4), [`62ec537`](https://github.com/vercel/workflow/commit/62ec5372fb7dc0d8d088be0c55db35d14eea5b14), [`503a929`](https://github.com/vercel/workflow/commit/503a929d347df46eb0ad63b068da7781762d0dc8)]:
  - @workflow/world@5.0.0-beta.5
  - @workflow/errors@5.0.0-beta.5

## 5.0.0-beta.6

### Patch Changes

- [#2038](https://github.com/vercel/workflow/pull/2038) [`dc0be50`](https://github.com/vercel/workflow/commit/dc0be50618bd6a465e3f9768ee7427d282aa1fd7) Thanks [@pranaygp](https://github.com/pranaygp)! - Refresh workflow events after completing elapsed waits so concurrent hook events preserve deterministic replay order.

- [#2013](https://github.com/vercel/workflow/pull/2013) [`2a446af`](https://github.com/vercel/workflow/commit/2a446af517dbb91ae959adade1d74ef0428a2b09) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Exclude inline step execution from the workflow replay timeout. Long-running steps no longer hit `REPLAY_TIMEOUT` (fixes #2009). Adds a `WORKFLOW_REPLAY_TIMEOUT_MS` env var override and a new optional `World.processExitTriggersQueueRedelivery` capability used to gate the runtime's `process.exit(1)` failure path.

- [#2060](https://github.com/vercel/workflow/pull/2060) [`1d3959e`](https://github.com/vercel/workflow/commit/1d3959eaa8db5866d08ad3970324c1b5dae73f7b) Thanks [@pranaygp](https://github.com/pranaygp)! - Record fatal world response contract failures as non-retryable workflow errors.

- Updated dependencies [[`dc0be50`](https://github.com/vercel/workflow/commit/dc0be50618bd6a465e3f9768ee7427d282aa1fd7), [`ad71b58`](https://github.com/vercel/workflow/commit/ad71b58bba65e739fbafee0440ffff48878e7e51), [`b124365`](https://github.com/vercel/workflow/commit/b124365e14b0c47a5c830c7009dd5bf0149d5a59), [`2a446af`](https://github.com/vercel/workflow/commit/2a446af517dbb91ae959adade1d74ef0428a2b09), [`1d3959e`](https://github.com/vercel/workflow/commit/1d3959eaa8db5866d08ad3970324c1b5dae73f7b)]:
  - @workflow/world@5.0.0-beta.4
  - @workflow/errors@5.0.0-beta.4

## 5.0.0-beta.5

### Patch Changes

- [#1999](https://github.com/vercel/workflow/pull/1999) [`c43e721`](https://github.com/vercel/workflow/commit/c43e721efc90e93575f0e1f36221b69d50074187) Thanks [@pranaygp](https://github.com/pranaygp)! - Release failed VQS workflow handler messages on the configured retry cadence.

- [#1987](https://github.com/vercel/workflow/pull/1987) [`22b5a12`](https://github.com/vercel/workflow/commit/22b5a1240f8f4dfee5536791fee981d50781ff1f) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Update to new queue client version

- Updated dependencies [[`9d2a926`](https://github.com/vercel/workflow/commit/9d2a9261fd9355b8e8f41342dd8b81b272162837)]:
  - @workflow/errors@5.0.0-beta.3
  - @workflow/world@5.0.0-beta.3

## 5.0.0-beta.4

### Major Changes

- [#1851](https://github.com/vercel/workflow/pull/1851) [`5f22832`](https://github.com/vercel/workflow/commit/5f228326757f7da349edfed89845bd109c98f104) Thanks [@TooTallNate](https://github.com/TooTallNate)! - **BREAKING CHANGE**: Run and step errors are now serialized through the workflow serialization pipeline, preserving original class identity and cause chains on `WorkflowRunFailedError.cause`. Pre-upgrade failed runs in the `world-postgres` legacy `error` text column surface as `error: undefined` on read; the original payload is still readable directly from the `errorJson` column for manual inspection.

### Minor Changes

- [#1882](https://github.com/vercel/workflow/pull/1882) [`cd50618`](https://github.com/vercel/workflow/commit/cd50618d1fc01ee6049047e415b794dd7ca54af9) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Switch the workflow-server Deployment Protection bypass to OIDC Trusted Sources. The `VERCEL_WORKFLOW_SERVER_PROTECTION_BYPASS` env var is no longer used; the `x-vercel-trusted-oidc-idp-token` header is now sourced from `getVercelOidcToken()`.

### Patch Changes

- [#1807](https://github.com/vercel/workflow/pull/1807) [`5eb0b79`](https://github.com/vercel/workflow/commit/5eb0b792b8a7f04d6558f27d4b0d29daa57a788d) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Add a default request timeout to world-vercel HTTP calls so hanging responses can be re-tried sooner and run less risk of continuing until a function timeout

- Updated dependencies [[`540a2ef`](https://github.com/vercel/workflow/commit/540a2efb99c137b0d60c7368376e9533ea662a4c), [`5374148`](https://github.com/vercel/workflow/commit/537414849b0f7022640879786ff85c918672e7d0), [`1203dae`](https://github.com/vercel/workflow/commit/1203dae70c802eef114909e9476e19ec528550cd), [`1203dae`](https://github.com/vercel/workflow/commit/1203dae70c802eef114909e9476e19ec528550cd), [`5f22832`](https://github.com/vercel/workflow/commit/5f228326757f7da349edfed89845bd109c98f104), [`8ea1532`](https://github.com/vercel/workflow/commit/8ea1532e48ed86ef9a66231e474851bed85c737a)]:
  - @workflow/errors@5.0.0-beta.2
  - @workflow/world@5.0.0-beta.2

## 5.0.0-beta.3

### Minor Changes

- [#1824](https://github.com/vercel/workflow/pull/1824) [`354840e`](https://github.com/vercel/workflow/commit/354840e93b46e2eae29d4b1f936b04a92db1890e) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `VERCEL_WORKFLOW_SERVER_PROTECTION_BYPASS` and `VERCEL_WORKFLOW_SERVER_URL` env vars.

## 5.0.0-beta.2

### Patch Changes

- [#1742](https://github.com/vercel/workflow/pull/1742) [`340c085`](https://github.com/vercel/workflow/commit/340c0856813b23e9be966a2022933d6040a3b062) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Use custom stream close control frame to decide whether to reconnect to stream

- [#1769](https://github.com/vercel/workflow/pull/1769) [`5a42964`](https://github.com/vercel/workflow/commit/5a4296412f151c255a8d08c8870e511222c7c472) Thanks [@tomdale](https://github.com/tomdale)! - Embed source content in published sourcemaps.

- Updated dependencies [[`5a42964`](https://github.com/vercel/workflow/commit/5a4296412f151c255a8d08c8870e511222c7c472), [`173756d`](https://github.com/vercel/workflow/commit/173756dc4d097fd90432e2c38c91ce1b959a6352)]:
  - @workflow/errors@5.0.0-beta.1

## 5.0.0-beta.1

### Major Changes

- [#1293](https://github.com/vercel/workflow/pull/1293) [`66d49c0`](https://github.com/vercel/workflow/commit/66d49c0db608b034c8fc1b4087a047e0be067b77) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - **BREAKING CHANGE**: Restructure stream methods on World interface to use `world.streams.*` namespace with `runId` as the first parameter. `writeToStream(name, runId, chunk)` → `streams.write(runId, name, chunk)`, `writeToStreamMulti` → `streams.writeMulti`, `closeStream` → `streams.close`, `readFromStream` → `streams.get(runId, name, startIndex?)`, `listStreamsByRunId` → `streams.list(runId)`.

- [#1293](https://github.com/vercel/workflow/pull/1293) [`66d49c0`](https://github.com/vercel/workflow/commit/66d49c0db608b034c8fc1b4087a047e0be067b77) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Require `runId` argument for `world.steps.get`.

### Patch Changes

- [#1658](https://github.com/vercel/workflow/pull/1658) [`a5c90ce`](https://github.com/vercel/workflow/commit/a5c90cefba01070aa4bc12a696334ee4c1061f92) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix community world E2E tests by adding `specVersion` to the World interface so `start()` uses the safe baseline (v2) for worlds that don't declare their supported version

- [#1676](https://github.com/vercel/workflow/pull/1676) [`68cf25e`](https://github.com/vercel/workflow/commit/68cf25e83bdc8bf912fb30cb8f9ba4cb9a30f087) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix `streams.get()` to include `runId` in the request URL instead of always omitting it.

- Updated dependencies [[`66d49c0`](https://github.com/vercel/workflow/commit/66d49c0db608b034c8fc1b4087a047e0be067b77), [`a5c90ce`](https://github.com/vercel/workflow/commit/a5c90cefba01070aa4bc12a696334ee4c1061f92), [`66d49c0`](https://github.com/vercel/workflow/commit/66d49c0db608b034c8fc1b4087a047e0be067b77)]:
  - @workflow/world@5.0.0-beta.1
  - @workflow/errors@5.0.0-beta.0

## 5.0.0-beta.0

### Major Changes

- [#1642](https://github.com/vercel/workflow/pull/1642) [`c5cdfc0`](https://github.com/vercel/workflow/commit/c5cdfc00751c5bef36c4be748d819081b934fbcd) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Initial v5 beta release

### Patch Changes

- Updated dependencies [[`c5cdfc0`](https://github.com/vercel/workflow/commit/c5cdfc00751c5bef36c4be748d819081b934fbcd)]:
  - @workflow/errors@5.0.0-beta.0
  - @workflow/world@5.0.0-beta.0

## 4.1.0-beta.49

### Patch Changes

- [#1627](https://github.com/vercel/workflow/pull/1627) [`5f138f2`](https://github.com/vercel/workflow/commit/5f138f2ceedcc96c9d043fa36378c4de781ab55b) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Bump specVersion to 3 and gate CBOR queue transport on spec version. Old deployments (specVersion < 3) receive JSON queue messages; new deployments receive CBOR. Handler uses dual transport to deserialize both formats. Fixes replay/reenqueue from dashboard to older deployments.

- [#1537](https://github.com/vercel/workflow/pull/1537) [`c8dce52`](https://github.com/vercel/workflow/commit/c8dce5260627a2f349618976e8478ce03e656536) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Allow workflow invocation to create run if initial storage call in `start` did not succeed. Send run input through queue to enable this. Allow creating run_created and run_started events together in World, and skip first event list call by returning events directly.

- [#1626](https://github.com/vercel/workflow/pull/1626) [`5b9eb40`](https://github.com/vercel/workflow/commit/5b9eb406a8e5b778739fd4f49f5b017e0680fa6d) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Paginate `writeToStreamMulti` to stay within the server's 1000 chunks per batch limit

- Updated dependencies [[`5f138f2`](https://github.com/vercel/workflow/commit/5f138f2ceedcc96c9d043fa36378c4de781ab55b), [`7e70d18`](https://github.com/vercel/workflow/commit/7e70d1823add7930d6df7f84e1a6a77d888eb851), [`c8dce52`](https://github.com/vercel/workflow/commit/c8dce5260627a2f349618976e8478ce03e656536)]:
  - @workflow/world@4.1.0-beta.17
  - @workflow/errors@4.1.0-beta.20

## 4.1.0-beta.48

### Patch Changes

- [#1602](https://github.com/vercel/workflow/pull/1602) [`760ebf1`](https://github.com/vercel/workflow/commit/760ebf161b0382cd430657cd1d172e8861660c30) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Update headers from x-workflow-run-id and x-workflow-step-id to x-vercel-workflow-run-id and x-vercel-workflow-step-id in order to align with header naming convention

- Updated dependencies [[`b30b0dc`](https://github.com/vercel/workflow/commit/b30b0dcab68a8cc37735ea6c1fb8cb4f06efbe8b)]:
  - @workflow/world@4.1.0-beta.16
  - @workflow/errors@4.1.0-beta.20

## 4.1.0-beta.47

### Patch Changes

- [#1588](https://github.com/vercel/workflow/pull/1588) [`ef2218a`](https://github.com/vercel/workflow/commit/ef2218ab22310afa04e4e1709906a86969126e52) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix zod v3/v4 schema mismatch crash (`keyValidator._parse is not a function`) by using consistent `zod/v4` imports in queue files that consume v4-native schemas from `@workflow/world`

## 4.1.0-beta.46

### Patch Changes

- Updated dependencies [[`a98f8de`](https://github.com/vercel/workflow/commit/a98f8de53f1af222cccea6d091b68d544957b4e3), [`6dc1b78`](https://github.com/vercel/workflow/commit/6dc1b785822af5c1dc3b4a2a9b1dcb7f626cf5ff), [`329cdb3`](https://github.com/vercel/workflow/commit/329cdb3e1b55e3a2e8eb6b5befff598d7184bd78)]:
  - @workflow/world@4.1.0-beta.15
  - @workflow/errors@4.1.0-beta.20

## 4.1.0-beta.45

### Patch Changes

- [#1340](https://github.com/vercel/workflow/pull/1340) [`84599b7`](https://github.com/vercel/workflow/commit/84599b7ec5c19207082523609f1b3508a1a18bd7) Thanks [@pranaygp](https://github.com/pranaygp)! - Add error code classification (`USER_ERROR`, `RUNTIME_ERROR`) to `run_failed` events, improve queue and schema validation error logging

- [#1442](https://github.com/vercel/workflow/pull/1442) [`fdbe853`](https://github.com/vercel/workflow/commit/fdbe853531ed07c6844dd08fa76a3c8b86f13db5) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - When `DEBUG=workflow:` is enabled, show API timing debug logs

- [#1342](https://github.com/vercel/workflow/pull/1342) [`aee035f`](https://github.com/vercel/workflow/commit/aee035f94483ef3b842bb557e8c5b167dd0536c4) Thanks [@pranaygp](https://github.com/pranaygp)! - Replace HTTP status code checks with semantic error types (EntityConflictError, RunExpiredError, ThrottleError, TooEarlyError). **BREAKING CHANGE**: `WorkflowAPIError` renamed to `WorkflowWorldError`.

- [#1429](https://github.com/vercel/workflow/pull/1429) [`741661b`](https://github.com/vercel/workflow/commit/741661b0bb07d2e3d3be1c51ed905468f1e8b93f) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Support refs inside `hook_received` event `payload`

- [#1470](https://github.com/vercel/workflow/pull/1470) [`01bbe66`](https://github.com/vercel/workflow/commit/01bbe66d5a60d50d71f5b1c82b002ca7fc6f8e0b) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add `getStreamChunks()` and `getStreamInfo()` to the Streamer interface, and `getTailIndex()` to the readable stream returned by `run.getReadable()`. `WorkflowChatTransport` now reads the `x-workflow-stream-tail-index` response header to resolve negative `initialStartIndex` values into absolute positions, fixing reconnection retries after a disconnect.

- Updated dependencies [[`73a851a`](https://github.com/vercel/workflow/commit/73a851ada6a4d46ae8f022ef243ebf4ee3de2ad8), [`84599b7`](https://github.com/vercel/workflow/commit/84599b7ec5c19207082523609f1b3508a1a18bd7), [`2ef33d2`](https://github.com/vercel/workflow/commit/2ef33d2828ac06debf04ad9cc239d70fea6a8093), [`672d919`](https://github.com/vercel/workflow/commit/672d9195a475a110a64dbaa7c5c87a24f244c11a), [`beccbc4`](https://github.com/vercel/workflow/commit/beccbc4298f434a4ffb9563c4f832f2230016f40), [`78f1b0e`](https://github.com/vercel/workflow/commit/78f1b0e19f2ac1a621020bc9fa5dec778f3b0fd9), [`aee035f`](https://github.com/vercel/workflow/commit/aee035f94483ef3b842bb557e8c5b167dd0536c4), [`01bbe66`](https://github.com/vercel/workflow/commit/01bbe66d5a60d50d71f5b1c82b002ca7fc6f8e0b)]:
  - @workflow/errors@4.1.0-beta.19
  - @workflow/world@4.1.0-beta.14

## 4.1.0-beta.44

### Patch Changes

- [#1378](https://github.com/vercel/workflow/pull/1378) [`d6e8727`](https://github.com/vercel/workflow/commit/d6e8727a948ce60d15af635763239d8321cd7cee) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Reorder token resolution in `fetchRunKey` and `resolveLatestDeploymentId` to prefer `options.token` / `VERCEL_TOKEN` before calling OIDC, skipping the OIDC network call when a token is already available

- [#1396](https://github.com/vercel/workflow/pull/1396) [`2f0772d`](https://github.com/vercel/workflow/commit/2f0772d3df4983de2f6618054379a496ade4ec5a) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Track Vercel request IDs (`x-vercel-id`) on all workflow events for correlating request logs with workflow executions

- [#1335](https://github.com/vercel/workflow/pull/1335) [`e902980`](https://github.com/vercel/workflow/commit/e9029807733d6a7dba76626ae61bd751e9a18fbe) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Use undici dispatcher for queue client

- [#1364](https://github.com/vercel/workflow/pull/1364) [`94c14c7`](https://github.com/vercel/workflow/commit/94c14c746b3218d13a5e2a7936c8cef505e7be08) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Strip only ref/payload fields from eventData when resolveData is 'none', preserving all other metadata

- Updated dependencies [[`2f0772d`](https://github.com/vercel/workflow/commit/2f0772d3df4983de2f6618054379a496ade4ec5a), [`94c14c7`](https://github.com/vercel/workflow/commit/94c14c746b3218d13a5e2a7936c8cef505e7be08)]:
  - @workflow/world@4.1.0-beta.13
  - @workflow/errors@4.1.0-beta.18

## 4.1.0-beta.43

### Patch Changes

- [#1317](https://github.com/vercel/workflow/pull/1317) [`825417a`](https://github.com/vercel/workflow/commit/825417acbaf7f721259427ecf4b7bc2a0e5cbef7) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Implement `resolveLatestDeploymentId()` that calls the Vercel API to resolve the latest deployment for the current environment

- [#1322](https://github.com/vercel/workflow/pull/1322) [`d5bc418`](https://github.com/vercel/workflow/commit/d5bc418816748ab2b5109ca7b082f3be427c326b) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Encode all user-supplied IDs in URL path segments with `encodeURIComponent()`

- Updated dependencies [[`825417a`](https://github.com/vercel/workflow/commit/825417acbaf7f721259427ecf4b7bc2a0e5cbef7)]:
  - @workflow/world@4.1.0-beta.12
  - @workflow/errors@4.1.0-beta.18

## 4.1.0-beta.42

### Patch Changes

- [#1262](https://github.com/vercel/workflow/pull/1262) [`9781afb`](https://github.com/vercel/workflow/commit/9781afb490b252f5656e5d48c61c038c3aef794f) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Use VERCEL=1 to distinguish serverless runtime from external contexts for encryption key resolution

- [#1309](https://github.com/vercel/workflow/pull/1309) [`d842ce1`](https://github.com/vercel/workflow/commit/d842ce1c435049805233cf218aa9ce07d9cab130) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Include response body and status text in fetchRunKey error message for better debuggability of rate limit and server errors.

## 4.1.0-beta.41

### Patch Changes

- [#1287](https://github.com/vercel/workflow/pull/1287) [`d8daa2a`](https://github.com/vercel/workflow/commit/d8daa2a9a95e2d01a4e6fee4e8dde51d82db762d) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add `world.events.get(runId, eventId)` to the Storage interface for fetching a single event by ID.

- Updated dependencies [[`d8daa2a`](https://github.com/vercel/workflow/commit/d8daa2a9a95e2d01a4e6fee4e8dde51d82db762d)]:
  - @workflow/world@4.1.0-beta.11
  - @workflow/errors@4.1.0-beta.18

## 4.1.0-beta.40

### Patch Changes

- [#1290](https://github.com/vercel/workflow/pull/1290) [`8b5a388`](https://github.com/vercel/workflow/commit/8b5a388a9451d7c7460481f0889da5037bd90893) Thanks [@pranaygp](https://github.com/pranaygp)! - Support `timeoutSeconds: 0` for immediate re-enqueue without arbitrary delay

## 4.1.0-beta.39

### Patch Changes

- [#1273](https://github.com/vercel/workflow/pull/1273) [`11dcb64`](https://github.com/vercel/workflow/commit/11dcb646d33e7a2b251d9388c2c8ecdd6aca73f7) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Locally validate run ID to be ULID when passed by user

- Updated dependencies [[`11dcb64`](https://github.com/vercel/workflow/commit/11dcb646d33e7a2b251d9388c2c8ecdd6aca73f7)]:
  - @workflow/world@4.1.0-beta.10
  - @workflow/errors@4.1.0-beta.18

## 4.1.0-beta.38

### Patch Changes

- [#1270](https://github.com/vercel/workflow/pull/1270) [`adfe8b6`](https://github.com/vercel/workflow/commit/adfe8b6b1123ce581aa9572bae91b8d7f9cdc53d) Thanks [@pranaygp](https://github.com/pranaygp)! - Add `HookNotFoundError` to `@workflow/errors` and adopt it across all world backends

- Updated dependencies [[`adfe8b6`](https://github.com/vercel/workflow/commit/adfe8b6b1123ce581aa9572bae91b8d7f9cdc53d), [`adfe8b6`](https://github.com/vercel/workflow/commit/adfe8b6b1123ce581aa9572bae91b8d7f9cdc53d)]:
  - @workflow/errors@4.1.0-beta.18
  - @workflow/world@4.1.0-beta.9

## 4.1.0-beta.37

### Patch Changes

- [#1222](https://github.com/vercel/workflow/pull/1222) [`2b1c2bd`](https://github.com/vercel/workflow/commit/2b1c2bd8e6b384334fbeb7ede8f517a5ca683716) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix `run_failed` event schema validation failure in lazy ref mode

## 4.1.0-beta.36

### Patch Changes

- [#1211](https://github.com/vercel/workflow/pull/1211) [`1cfb8b1`](https://github.com/vercel/workflow/commit/1cfb8b12e7d40e372d6e223add1518cd62fa0b5f) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Use undici v7 Agent for HTTP/2 multiplexing and automatic retry

- [#1220](https://github.com/vercel/workflow/pull/1220) [`274ea8b`](https://github.com/vercel/workflow/commit/274ea8b5720c03d564b567edb3fdeb97a6db2c09) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Vary ref resolution concurrency based on header

- [#1218](https://github.com/vercel/workflow/pull/1218) [`f3b2e08`](https://github.com/vercel/workflow/commit/f3b2e08adbb259670445bba7cea79cfd25c8370b) Thanks [@ctgowrie](https://github.com/ctgowrie)! - Update to new queue client version

- [#1217](https://github.com/vercel/workflow/pull/1217) [`e55c636`](https://github.com/vercel/workflow/commit/e55c63678b15b6687cc77efca705ee9fb40fabc3) Thanks [@pranaygp](https://github.com/pranaygp)! - Upgrade dependencies across all packages

- Updated dependencies [[`e55c636`](https://github.com/vercel/workflow/commit/e55c63678b15b6687cc77efca705ee9fb40fabc3)]:
  - @workflow/world@4.1.0-beta.8
  - @workflow/errors@4.1.0-beta.17

## 4.1.0-beta.35

### Patch Changes

- [#1189](https://github.com/vercel/workflow/pull/1189) [`b224521`](https://github.com/vercel/workflow/commit/b224521cb09c6741423783140c50148b0c98d227) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Move event ref resolution from server-side to client-side to reduce memory pressure

- [`49d1b6d`](https://github.com/vercel/workflow/commit/49d1b6d57ea6b9283eef7158dcd4881caa18091f) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Include total blob and stream storage size of a run in the run response

- [#1174](https://github.com/vercel/workflow/pull/1174) [`e1a2f47`](https://github.com/vercel/workflow/commit/e1a2f475aa3258ee9e36e0694f73dbbe72b49fbe) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Handle `{ key: null }` response from the run-key API endpoint, returning `undefined` to signal encryption is disabled for that workflow run

- [#1183](https://github.com/vercel/workflow/pull/1183) [`c614456`](https://github.com/vercel/workflow/commit/c6144564eab0168bbb00350839c04f5f009dcd8e) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Pass `teamId` to the run-key API endpoint for team-scoped encryption key retrieval

- [#1188](https://github.com/vercel/workflow/pull/1188) [`b06e491`](https://github.com/vercel/workflow/commit/b06e491a4769724435afff66724ac9e275fe11df) Thanks [@ctgowrie](https://github.com/ctgowrie)! - New vercel queue client

- Updated dependencies [[`b06e491`](https://github.com/vercel/workflow/commit/b06e491a4769724435afff66724ac9e275fe11df)]:
  - @workflow/world@4.1.0-beta.7
  - @workflow/errors@4.1.0-beta.16

## 4.1.0-beta.34

### Patch Changes

- [#956](https://github.com/vercel/workflow/pull/956) [`b65bb07`](https://github.com/vercel/workflow/commit/b65bb072b540e9e5fb6bc3f72c4132667cc60277) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Implement `getEncryptionKeyForRun` with HKDF-SHA256 per-run key derivation and cross-deployment key resolution via `fetchRunKey` API

- Updated dependencies [[`b65bb07`](https://github.com/vercel/workflow/commit/b65bb072b540e9e5fb6bc3f72c4132667cc60277)]:
  - @workflow/world@4.1.0-beta.6
  - @workflow/errors@4.1.0-beta.16

## 4.1.0-beta.33

### Patch Changes

- [#1098](https://github.com/vercel/workflow/pull/1098) [`7046610`](https://github.com/vercel/workflow/commit/704661078f6d6065f9b5dcd28c0b98ae91034143) Thanks [@pranaygp](https://github.com/pranaygp)! - Auto-inject `x-workflow-run-id` and `x-workflow-step-id` VQS headers from queue payload in `world-vercel`

- [#999](https://github.com/vercel/workflow/pull/999) [`ea3254e`](https://github.com/vercel/workflow/commit/ea3254e7ce28cef6b9b829ac7ad379921dd41ed9) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Separate project ID and project name into distinct env vars (WORKFLOW_VERCEL_PROJECT and WORKFLOW_VERCEL_PROJECT_NAME)

- [#1096](https://github.com/vercel/workflow/pull/1096) [`29347b7`](https://github.com/vercel/workflow/commit/29347b79eae8181d02ed1e52183983adc56425fd) Thanks [@ctgowrie](https://github.com/ctgowrie)! - Use new Vercel queue client with v2 message format, simplified callback handling, etc.

- Updated dependencies [[`c2b4fe9`](https://github.com/vercel/workflow/commit/c2b4fe9906fd0845fef646669034cd203d97a18d), [`6e72b29`](https://github.com/vercel/workflow/commit/6e72b295e71c1a9e0a91dbe1137eca7b88227e1f), [`5e06a7c`](https://github.com/vercel/workflow/commit/5e06a7c8332042a4835fa0e469e1031fec742668), [`5487983`](https://github.com/vercel/workflow/commit/54879835f390299f9249523e0488bbdca708fb68)]:
  - @workflow/errors@4.1.0-beta.16
  - @workflow/world@4.1.0-beta.5

## 4.1.0-beta.32

### Patch Changes

- [#966](https://github.com/vercel/workflow/pull/966) [`56f2221`](https://github.com/vercel/workflow/commit/56f22219b338a5a2c29466798a5ad36a6a450498) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add 429 throttle retry handling and 500 server error retry with exponential backoff to the workflow and step runtimes

- Updated dependencies [[`56f2221`](https://github.com/vercel/workflow/commit/56f22219b338a5a2c29466798a5ad36a6a450498)]:
  - @workflow/errors@4.1.0-beta.15
  - @workflow/world@4.1.0-beta.4

## 4.1.0-beta.31

### Patch Changes

- [#985](https://github.com/vercel/workflow/pull/985) [`aa448c2`](https://github.com/vercel/workflow/commit/aa448c29b4c3853985eaa1bcbbf2029165edade3) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Allow overwriting backend URL via env variable

- Updated dependencies [[`d9e9859`](https://github.com/vercel/workflow/commit/d9e98590fae17fd090e0be4f0b54bbaa80c7be69)]:
  - @workflow/world@4.1.0-beta.3
  - @workflow/errors@4.1.0-beta.14

## 4.1.0-beta.30

### Patch Changes

- [#922](https://github.com/vercel/workflow/pull/922) [`0ce46b9`](https://github.com/vercel/workflow/commit/0ce46b91d9c8ca3349f43cdf3a5d75a948d6f5ad) Thanks [@pranaygp](https://github.com/pranaygp)! - Add support for custom headers in queue messages

- [#867](https://github.com/vercel/workflow/pull/867) [`c54ba21`](https://github.com/vercel/workflow/commit/c54ba21c19040577ed95f6264a2670f190e1d1d3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add optional `writeToStreamMulti` function to the World interface

- [#933](https://github.com/vercel/workflow/pull/933) [`79e988f`](https://github.com/vercel/workflow/commit/79e988fa85f0ebdd5c8913b8de84e01c55d020b9) Thanks [@pranaygp](https://github.com/pranaygp)! - Add OTEL tracing for HTTP requests and storage operations using standard OTEL semantic conventions

- [#932](https://github.com/vercel/workflow/pull/932) [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6) Thanks [@pranaygp](https://github.com/pranaygp)! - Improve world-vercel telemetry and event creation performance
  - Use parent application's 'workflow' tracer instead of separate service name
  - Add `peer.service` and RPC semantic conventions for Datadog service maps
  - Include event type in `world.events.create` span names (e.g., `world.events.create step_started`)
  - Use lazy ref resolution for fire-and-forget events to skip S3 ref resolution (~200-460ms savings)

- Updated dependencies [[`0ce46b9`](https://github.com/vercel/workflow/commit/0ce46b91d9c8ca3349f43cdf3a5d75a948d6f5ad), [`c54ba21`](https://github.com/vercel/workflow/commit/c54ba21c19040577ed95f6264a2670f190e1d1d3)]:
  - @workflow/world@4.1.0-beta.2
  - @workflow/errors@4.1.0-beta.14

## 4.1.0-beta.29

### Minor Changes

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - **BREAKING**: Storage interface is now read-only; all mutations go through `events.create()`
  - Remove `cancel`, `pause`, `resume` from `runs`
  - Remove `create`, `update` from `runs`, `steps`, `hooks`
  - Add run lifecycle events: `run_created`, `run_started`, `run_completed`, `run_failed`, `run_cancelled`
  - Add `step_created` event type
  - Remove `fatal` field from `step_failed` (terminal failure is now implicit)
  - Add `step_retrying` event with error info for retriable failures

### Patch Changes

- [#799](https://github.com/vercel/workflow/pull/799) [`26a9833`](https://github.com/vercel/workflow/commit/26a98330d478dd76192d9897b5a0cc0cf3feacd7) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Update queue implementation to use VQS v3

- [#844](https://github.com/vercel/workflow/pull/844) [`b59559b`](https://github.com/vercel/workflow/commit/b59559be70e839025680c4f9873d521170e48e1c) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Submit request bodies with CBOR encoding

- [#894](https://github.com/vercel/workflow/pull/894) [`a2b688d`](https://github.com/vercel/workflow/commit/a2b688d0623ebbae117877a696c5b9b288d628fd) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix resuming v1 hooks and cancelling/re-running v1 runs from a v2 UI or runtime

- [#833](https://github.com/vercel/workflow/pull/833) [`bd8116d`](https://github.com/vercel/workflow/commit/bd8116d40bf8d662537bf015d2861f6d1768d69e) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Remove `skipProxy` and `baseUrl` config options, simplify proxy logic

- [#853](https://github.com/vercel/workflow/pull/853) [`1060f9d`](https://github.com/vercel/workflow/commit/1060f9d04a372bf6de6c5c3d52063bcc22dba6e8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - **BREAKING CHANGE**: Change user input/output to be binary data (Uint8Array) at the World interface

  This is part of specVersion 2 changes where serialization of workflow and step data uses binary format instead of JSON arrays. This allows the workflow client to be fully responsible for the data serialization format and enables future enhancements such as encryption and compression without the World implementation needing to care about the underlying data representation.

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - Add `specVersion` property to World interface
  - All worlds expose `@workflow/world` package version for protocol compatibility
  - Stored in `run_created` event and `WorkflowRun` schema
  - Displayed in observability UI

- [#832](https://github.com/vercel/workflow/pull/832) [`b973b8d`](https://github.com/vercel/workflow/commit/b973b8d00f6459fa675ee9875642e49760f68879) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add support for CBOR responses

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - Route entity mutations through v2 events API
  - `events.create()` calls v2 endpoint for atomic entity creation
  - Remove `cancel`, `pause`, `resume` from storage interface

- Updated dependencies [[`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`1060f9d`](https://github.com/vercel/workflow/commit/1060f9d04a372bf6de6c5c3d52063bcc22dba6e8), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae)]:
  - @workflow/world@4.1.0-beta.1
  - @workflow/errors@4.1.0-beta.14

## 4.0.1-beta.28

### Patch Changes

- [#820](https://github.com/vercel/workflow/pull/820) [`f3785f0`](https://github.com/vercel/workflow/commit/f3785f04fbdf9e6199e0e42c592e3d5ba246a6c6) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Throw an error if no deployment ID was specified

## 4.0.1-beta.27

### Patch Changes

- Updated dependencies [[`61fdb41`](https://github.com/vercel/workflow/commit/61fdb41e1b5cd52c7b23fa3c0f3fcaa50c4189ca), [`0aa835f`](https://github.com/vercel/workflow/commit/0aa835fe30d4d61e2d6dcde693d6fbb24be72c66)]:
  - @workflow/world@4.0.1-beta.13
  - @workflow/errors@4.0.1-beta.13

## 4.0.1-beta.26

### Patch Changes

- [#751](https://github.com/vercel/workflow/pull/751) [`dd3db13`](https://github.com/vercel/workflow/commit/dd3db13d5498622284ed97c1a273d2942478b167) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Remove the unused paused/resumed run events and states
  - Remove `run_paused` and `run_resumed` event types
  - Remove `paused` status from `WorkflowRunStatus`
  - Remove `PauseWorkflowRunParams` and `ResumeWorkflowRunParams` types
  - Remove `pauseWorkflowRun` and `resumeWorkflowRun` functions from world-vercel

- Updated dependencies [[`dd3db13`](https://github.com/vercel/workflow/commit/dd3db13d5498622284ed97c1a273d2942478b167)]:
  - @workflow/world@4.0.1-beta.12
  - @workflow/errors@4.0.1-beta.13

## 4.0.1-beta.25

### Patch Changes

- Updated dependencies []:
  - @workflow/errors@4.0.1-beta.13

## 4.0.1-beta.24

### Patch Changes

- Updated dependencies [[`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6)]:
  - @workflow/world@4.0.1-beta.11
  - @workflow/errors@4.0.1-beta.12

## 4.0.1-beta.23

### Patch Changes

- Updated dependencies []:
  - @workflow/errors@4.0.1-beta.11

## 4.0.1-beta.22

### Patch Changes

- [#651](https://github.com/vercel/workflow/pull/651) [`75a5060`](https://github.com/vercel/workflow/commit/75a506047304f6dd1ac07d9150e8a9563f69283c) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Handle Vercel Queue 24 hour message TTL by re-enqueueing message

- [#647](https://github.com/vercel/workflow/pull/647) [`6cd1a47`](https://github.com/vercel/workflow/commit/6cd1a47b3146770f5cb9d4c384971331aab6b28a) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Additional error debugging when failing to validate server response

## 4.0.1-beta.21

### Patch Changes

- [#639](https://github.com/vercel/workflow/pull/639) [`ab55ba2`](https://github.com/vercel/workflow/commit/ab55ba2d61b41e2b2cd9e213069c93be988c9b1e) Thanks [@adriandlam](https://github.com/adriandlam)! - Add custom request header to bypass RSC request memoization

- Updated dependencies [[`4bdd3e5`](https://github.com/vercel/workflow/commit/4bdd3e5086a51a46898cca774533019d3ace77b3)]:
  - @workflow/errors@4.0.1-beta.10

## 4.0.1-beta.20

### Patch Changes

- [#627](https://github.com/vercel/workflow/pull/627) [`deaf019`](https://github.com/vercel/workflow/commit/deaf0193e91ea7a24d2423a813b64f51faa681e3) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - [world-vercel] Allow skipping vercel backend proxy for e2e tests where CLI runs in runtime env

- Updated dependencies [[`b56aae3`](https://github.com/vercel/workflow/commit/b56aae3fe9b5568d7bdda592ed025b3499149240)]:
  - @workflow/errors@4.0.1-beta.9

## 4.0.1-beta.19

### Patch Changes

- Updated dependencies []:
  - @workflow/errors@4.0.1-beta.8

## 4.0.1-beta.18

### Patch Changes

- [#574](https://github.com/vercel/workflow/pull/574) [`c82b467`](https://github.com/vercel/workflow/commit/c82b46720cf6284f3c7e3ded107e1d8321f6e705) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add listByRunId endpoint to Streamer interface

- Updated dependencies [[`c82b467`](https://github.com/vercel/workflow/commit/c82b46720cf6284f3c7e3ded107e1d8321f6e705)]:
  - @workflow/world@4.0.1-beta.10
  - @workflow/errors@4.0.1-beta.7

## 4.0.1-beta.17

### Patch Changes

- Updated dependencies [57a2c32]
  - @workflow/world@4.0.1-beta.9
  - @workflow/errors@4.0.1-beta.7

## 4.0.1-beta.16

### Patch Changes

- c8fa70a: Change Vercel queue max visibility to 11 hours

## 4.0.1-beta.15

### Patch Changes

- e9494d5: Update `@vercel/queue` to use new QueueClient class to simplify custom header/path overwrites

## 4.0.1-beta.14

### Patch Changes

- Updated dependencies [10c5b91]
- Updated dependencies [bdde1bd]
  - @workflow/world@4.0.1-beta.8
  - @workflow/errors@4.0.1-beta.7

## 4.0.1-beta.13

### Patch Changes

- Updated dependencies [fb9fd0f]
  - @workflow/world@4.0.1-beta.7
  - @workflow/errors@4.0.1-beta.6

## 4.0.1-beta.12

### Patch Changes

- 6889dac: Log warning when detecting zod v3

## 4.0.1-beta.11

### Patch Changes

- 2c438c3: Make queue() call backwardscompatible with zod v3 for codebases that pin zod
  - @workflow/errors@4.0.1-beta.6

## 4.0.1-beta.10

### Patch Changes

- 3d99d6d: Update `@vercel/oidc` and `@vercel/queue` to fix expired OIDC token edge case

## 4.0.1-beta.9

### Patch Changes

- 4b70739: Require specifying runId when writing to stream
- Updated dependencies [4b70739]
  - @workflow/world@4.0.1-beta.6
  - @workflow/errors@4.0.1-beta.5

## 4.0.1-beta.8

### Patch Changes

- b97b6bf: Lock all dependencies in our packages
- 00b0bb9: Support structured errors for steps and runs
- Updated dependencies [b97b6bf]
- Updated dependencies [00b0bb9]
- Updated dependencies [00b0bb9]
  - @workflow/errors@4.0.1-beta.5
  - @workflow/world@4.0.1-beta.5

## 4.0.1-beta.7

### Patch Changes

- 2dca0d4: Add custom user agent

## 4.0.1-beta.6

### Patch Changes

- @workflow/errors@4.0.1-beta.4

## 4.0.1-beta.5

### Patch Changes

- f973954: Update license to Apache 2.0
- Updated dependencies [f973954]
  - @workflow/errors@4.0.1-beta.3
  - @workflow/world@4.0.1-beta.4

## 4.0.1-beta.4

### Patch Changes

- 20d51f0: Enforce the Vercel Queue max visibility limit
- Updated dependencies [796fafd]
- Updated dependencies [20d51f0]
- Updated dependencies [70be894]
  - @workflow/errors@4.0.1-beta.2
  - @workflow/world@4.0.1-beta.3

## 4.0.1-beta.3

### Patch Changes

- e367046: Allow setting baseUrl and token for queue service

## 4.0.1-beta.2

### Patch Changes

- 7868434: Remove `AuthProvider` interface from `World` and associated implementations
- Updated dependencies [d3a4ed3]
- Updated dependencies [d3a4ed3]
- Updated dependencies [7868434]
  - @workflow/world@4.0.1-beta.2

## 4.0.1-beta.1

### Patch Changes

- 1408293: Add "description" field to `package.json` file
- e46294f: Add "license" and "repository" fields to `package.json` file
- Updated dependencies [1408293]
- Updated dependencies [8422a32]
- Updated dependencies [e46294f]
  - @workflow/errors@4.0.1-beta.1
  - @workflow/world@4.0.1-beta.1

## 4.0.1-beta.0

### Patch Changes

- fcf63d0: Initial publish
- Updated dependencies [fcf63d0]
  - @workflow/errors@4.0.1-beta.0
  - @workflow/world@4.0.1-beta.0
