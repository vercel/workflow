# @workflow/cli

## 5.0.0-beta.3

### Patch Changes

- [#1686](https://github.com/vercel/workflow/pull/1686) [`417c493`](https://github.com/vercel/workflow/commit/417c4930be3d21768c7efd4d224510a33d8c468c) Thanks [@TooTallNate](https://github.com/TooTallNate)! - **BREAKING CHANGE**: Remove `client` transform mode from SWC plugin. The `client` and `step` modes were nearly identical — both preserved step function bodies, replaced workflow bodies with throw stubs, and emitted the same JSON manifest. The only differences were the step registration mechanism (simple property assignment vs. IIFE) and whether DCE ran. Step mode now absorbs all client-mode behaviors: hoisted variable references for object property steps (so `.stepId` is accessible), and dead code elimination. All integrations that previously used `mode: 'client'` now use `mode: 'step'`.

- Updated dependencies [[`9ea1254`](https://github.com/vercel/workflow/commit/9ea125427f4d96acf142b8b8deca0594e7ee1e7b), [`baba580`](https://github.com/vercel/workflow/commit/baba580794f636fa371d86634a2eac7bf367da12), [`7d07fab`](https://github.com/vercel/workflow/commit/7d07fab692ba79d0339b093a45f5beecb219639e), [`417c493`](https://github.com/vercel/workflow/commit/417c4930be3d21768c7efd4d224510a33d8c468c), [`e295bae`](https://github.com/vercel/workflow/commit/e295bae417bd072f8e18e8d07c76d90d40ae7cec), [`3ad8ee7`](https://github.com/vercel/workflow/commit/3ad8ee7e33e4639cf0e4778c1e87b96a17a74c56), [`354840e`](https://github.com/vercel/workflow/commit/354840e93b46e2eae29d4b1f936b04a92db1890e)]:
  - @workflow/web@5.0.0-beta.3
  - @workflow/builders@5.0.0-beta.3
  - @workflow/core@5.0.0-beta.3
  - @workflow/swc-plugin@5.0.0-beta.3
  - @workflow/world-local@5.0.0-beta.3
  - @workflow/world-vercel@5.0.0-beta.3

## 5.0.0-beta.2

### Patch Changes

- [#1769](https://github.com/vercel/workflow/pull/1769) [`5a42964`](https://github.com/vercel/workflow/commit/5a4296412f151c255a8d08c8870e511222c7c472) Thanks [@tomdale](https://github.com/tomdale)! - Embed source content in published sourcemaps.

- [#1736](https://github.com/vercel/workflow/pull/1736) [`eba7df3`](https://github.com/vercel/workflow/commit/eba7df381c88df55f0a43c9c87f1f77f98ae78e2) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Fix false "data expired" warning for runs with future expiredAt

- [#1759](https://github.com/vercel/workflow/pull/1759) [`173756d`](https://github.com/vercel/workflow/commit/173756dc4d097fd90432e2c38c91ce1b959a6352) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Rename `useworkflow.dev` URLs to `workflow-sdk.dev`

- Updated dependencies [[`c57eeff`](https://github.com/vercel/workflow/commit/c57eeff0ce37c86f58dad5c35c433b36fc9d3952), [`bcf818c`](https://github.com/vercel/workflow/commit/bcf818c2c7fc3f6650b2a9ad925bcbc0530e6ebb), [`340c085`](https://github.com/vercel/workflow/commit/340c0856813b23e9be966a2022933d6040a3b062), [`df115fd`](https://github.com/vercel/workflow/commit/df115fde8cb4baa9a02477db043bf3d6d97259c8), [`0810b75`](https://github.com/vercel/workflow/commit/0810b75872e96d8d8aa6e3dbf4236304d57526a7), [`5a42964`](https://github.com/vercel/workflow/commit/5a4296412f151c255a8d08c8870e511222c7c472), [`e788e3b`](https://github.com/vercel/workflow/commit/e788e3b41cce49335f4a7b5bf12907e30f2fb5f0), [`b7d6595`](https://github.com/vercel/workflow/commit/b7d6595c25dab6fe902a47e699b1818ecf1efb86), [`11cfb8f`](https://github.com/vercel/workflow/commit/11cfb8f3fb4c64bde92cf51a5990a7773c263f94), [`ac09f40`](https://github.com/vercel/workflow/commit/ac09f407719413671b6feea4dca2360ebda9a51f), [`136bd35`](https://github.com/vercel/workflow/commit/136bd35a98a40a5dc55b2fbf838924c0af001ba7), [`173756d`](https://github.com/vercel/workflow/commit/173756dc4d097fd90432e2c38c91ce1b959a6352)]:
  - @workflow/web@5.0.0-beta.2
  - @workflow/world-vercel@5.0.0-beta.2
  - @workflow/core@5.0.0-beta.2
  - @workflow/builders@5.0.0-beta.2
  - @workflow/errors@5.0.0-beta.1
  - @workflow/utils@5.0.0-beta.1
  - @workflow/world-local@5.0.0-beta.2
  - @workflow/swc-plugin@5.0.0-beta.2

## 5.0.0-beta.1

### Major Changes

- [#1293](https://github.com/vercel/workflow/pull/1293) [`66d49c0`](https://github.com/vercel/workflow/commit/66d49c0db608b034c8fc1b4087a047e0be067b77) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - **BREAKING CHANGE**: Restructure stream methods on World interface to use `world.streams.*` namespace with `runId` as the first parameter. `writeToStream(name, runId, chunk)` → `streams.write(runId, name, chunk)`, `writeToStreamMulti` → `streams.writeMulti`, `closeStream` → `streams.close`, `readFromStream` → `streams.get(runId, name, startIndex?)`, `listStreamsByRunId` → `streams.list(runId)`.

- [#1293](https://github.com/vercel/workflow/pull/1293) [`66d49c0`](https://github.com/vercel/workflow/commit/66d49c0db608b034c8fc1b4087a047e0be067b77) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Require `runId` argument for `world.steps.get`.

### Patch Changes

- [#1562](https://github.com/vercel/workflow/pull/1562) [`e436242`](https://github.com/vercel/workflow/commit/e4362421abf9c864c9c1064866ddfc16560649cb) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Switch Vercel Build Output API and standalone builder output from CJS to ESM. Step bundles, workflow bundles, and webhook bundles now emit ESM format by default, preserving native `import.meta.url` support and eliminating the need for CJS polyfills. Fully-bundled ESM output includes a `createRequire` banner to support CJS dependencies that use `require()` for Node.js builtins. The intermediate workflow bundle (which runs inside `vm.runInContext`) remains CJS as required by the VM execution model.

- [#942](https://github.com/vercel/workflow/pull/942) [`873b4e2`](https://github.com/vercel/workflow/commit/873b4e2bb451e0a4d28e0a96671c25e1db4932db) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - **BREAKING CHANGE**: Make `getWorld` and `createWorld` asynchronous to support ESM dynamic imports for custom world modules. All callers must now `await getWorld()`.

- Updated dependencies [[`d040182`](https://github.com/vercel/workflow/commit/d0401829320c2880a0a5c2404ed9dede94eb17a0), [`66d49c0`](https://github.com/vercel/workflow/commit/66d49c0db608b034c8fc1b4087a047e0be067b77), [`dc0c0dc`](https://github.com/vercel/workflow/commit/dc0c0dce7f4ef1a0919d7ecc7efe076564871d0c), [`e436242`](https://github.com/vercel/workflow/commit/e4362421abf9c864c9c1064866ddfc16560649cb), [`ec517fa`](https://github.com/vercel/workflow/commit/ec517fa2254131f47cc878177c4d2aa163d584a5), [`a5c90ce`](https://github.com/vercel/workflow/commit/a5c90cefba01070aa4bc12a696334ee4c1061f92), [`ea97bd6`](https://github.com/vercel/workflow/commit/ea97bd600711f67649509b21c7af5808fb13479f), [`68cf25e`](https://github.com/vercel/workflow/commit/68cf25e83bdc8bf912fb30cb8f9ba4cb9a30f087), [`0a86de3`](https://github.com/vercel/workflow/commit/0a86de3afd1b51efff32e1c3cefd7f384d1b2d8d), [`32a17b4`](https://github.com/vercel/workflow/commit/32a17b4033dea3d9fd496e77142c675b06f0e016), [`71d39d2`](https://github.com/vercel/workflow/commit/71d39d2f8d5739c22fb9d777e70d003b07d05987), [`873b4e2`](https://github.com/vercel/workflow/commit/873b4e2bb451e0a4d28e0a96671c25e1db4932db), [`66585fd`](https://github.com/vercel/workflow/commit/66585fd46723604a632d08b6c973d5a95582b1af), [`0a86de3`](https://github.com/vercel/workflow/commit/0a86de3afd1b51efff32e1c3cefd7f384d1b2d8d), [`89d242f`](https://github.com/vercel/workflow/commit/89d242fae2233c52153315d63e1eacb4c0ca5527), [`66d49c0`](https://github.com/vercel/workflow/commit/66d49c0db608b034c8fc1b4087a047e0be067b77), [`ebb0a4a`](https://github.com/vercel/workflow/commit/ebb0a4a4e366eb1be1d385bf1eedbbe27371c9a9), [`9513a81`](https://github.com/vercel/workflow/commit/9513a8160cc13ac2b3923a0d9500cd80eb477109)]:
  - @workflow/swc-plugin@5.0.0-beta.1
  - @workflow/world@5.0.0-beta.1
  - @workflow/world-local@5.0.0-beta.1
  - @workflow/world-vercel@5.0.0-beta.1
  - @workflow/core@5.0.0-beta.1
  - @workflow/web@5.0.0-beta.1
  - @workflow/builders@5.0.0-beta.1
  - @workflow/errors@5.0.0-beta.0

## 5.0.0-beta.0

### Major Changes

- [#1642](https://github.com/vercel/workflow/pull/1642) [`c5cdfc0`](https://github.com/vercel/workflow/commit/c5cdfc00751c5bef36c4be748d819081b934fbcd) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Initial v5 beta release

### Patch Changes

- Updated dependencies [[`35b539b`](https://github.com/vercel/workflow/commit/35b539b146015fd63ad71e0d08614de96d34aa45), [`372abba`](https://github.com/vercel/workflow/commit/372abba55fc6d3d9ba8f6926d38e05d7a6d99011), [`bab8cdd`](https://github.com/vercel/workflow/commit/bab8cddf98e1d4ca897fbfc9cc1fb51a3333c695), [`c5cdfc0`](https://github.com/vercel/workflow/commit/c5cdfc00751c5bef36c4be748d819081b934fbcd)]:
  - @workflow/builders@5.0.0-beta.0
  - @workflow/swc-plugin@5.0.0-beta.0
  - @workflow/core@5.0.0-beta.0
  - @workflow/errors@5.0.0-beta.0
  - @workflow/utils@5.0.0-beta.0
  - @workflow/web@5.0.0-beta.0
  - @workflow/world@5.0.0-beta.0
  - @workflow/world-local@5.0.0-beta.0
  - @workflow/world-vercel@5.0.0-beta.0

## 4.2.0-beta.78

### Patch Changes

- [#1552](https://github.com/vercel/workflow/pull/1552) [`f5d2aef`](https://github.com/vercel/workflow/commit/f5d2aef58ff6d655989d00e4b9a8712d856bdca0) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `workflow transform` command for inspecting SWC transform output with optional serde compliance analysis

- [#1552](https://github.com/vercel/workflow/pull/1552) [`f5d2aef`](https://github.com/vercel/workflow/commit/f5d2aef58ff6d655989d00e4b9a8712d856bdca0) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Implement serde compliance checks in `workflow validate`

- [#1629](https://github.com/vercel/workflow/pull/1629) [`a6bcea9`](https://github.com/vercel/workflow/commit/a6bcea9d2827731040cb20f1615c5127530fc310) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - CLI `start` command probes deployment specVersion via health check before choosing queue transport. Health check always uses JSON transport for compatibility with old deployments.

- [#1414](https://github.com/vercel/workflow/pull/1414) [`2680a42`](https://github.com/vercel/workflow/commit/2680a427f0f15182ce559bdab620a1c6d463c3f3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `Request` and `Response` revivers to web and CLI hydration so serialized Request/Response objects display correctly in the observability UI and CLI inspect output.

- Updated dependencies [[`f5d2aef`](https://github.com/vercel/workflow/commit/f5d2aef58ff6d655989d00e4b9a8712d856bdca0), [`5f138f2`](https://github.com/vercel/workflow/commit/5f138f2ceedcc96c9d043fa36378c4de781ab55b), [`a6bcea9`](https://github.com/vercel/workflow/commit/a6bcea9d2827731040cb20f1615c5127530fc310), [`7e70d18`](https://github.com/vercel/workflow/commit/7e70d1823add7930d6df7f84e1a6a77d888eb851), [`ba916e1`](https://github.com/vercel/workflow/commit/ba916e1566acc56533e7f5fcebbb8466360e0581), [`c9b3038`](https://github.com/vercel/workflow/commit/c9b30381f4e219fdd67bb3ef358f41697ed8c3e5), [`3308701`](https://github.com/vercel/workflow/commit/3308701b341f5b4d7007d5bca97cbbb6e4af222f), [`c8dce52`](https://github.com/vercel/workflow/commit/c8dce5260627a2f349618976e8478ce03e656536), [`ab872cc`](https://github.com/vercel/workflow/commit/ab872cc9fb6c24091c8c0eeb0efa7d0cbbdf20d8), [`5b9eb40`](https://github.com/vercel/workflow/commit/5b9eb406a8e5b778739fd4f49f5b017e0680fa6d)]:
  - @workflow/builders@4.0.1-beta.69
  - @workflow/world-vercel@4.1.0-beta.49
  - @workflow/world@4.1.0-beta.17
  - @workflow/core@4.2.0-beta.78
  - @workflow/world-local@4.1.0-beta.51
  - @workflow/web@4.1.0-beta.47
  - @workflow/errors@4.1.0-beta.20

## 4.2.0-beta.77

### Patch Changes

- Updated dependencies [[`b30b0dc`](https://github.com/vercel/workflow/commit/b30b0dcab68a8cc37735ea6c1fb8cb4f06efbe8b), [`760ebf1`](https://github.com/vercel/workflow/commit/760ebf161b0382cd430657cd1d172e8861660c30), [`d1330cf`](https://github.com/vercel/workflow/commit/d1330cfebca1b2f552bd80c06e37bff4fba1b79e), [`d8aaf27`](https://github.com/vercel/workflow/commit/d8aaf27c7913a1a44561325c9a08f50b4340100d), [`5d22e61`](https://github.com/vercel/workflow/commit/5d22e61446d5146887f8c268d305ea42e3f67b09), [`047c01b`](https://github.com/vercel/workflow/commit/047c01bc1545845b4251a58a380e627ef164e6d5), [`7c996a7`](https://github.com/vercel/workflow/commit/7c996a76c59cb88fa58d15942218b308d1cd100f), [`443a9e6`](https://github.com/vercel/workflow/commit/443a9e62f938b91cd818106155d384329cf5c82c)]:
  - @workflow/world@4.1.0-beta.16
  - @workflow/world-local@4.1.0-beta.50
  - @workflow/world-vercel@4.1.0-beta.48
  - @workflow/builders@4.0.1-beta.68
  - @workflow/core@4.2.0-beta.77
  - @workflow/swc-plugin@4.1.0-beta.22
  - @workflow/errors@4.1.0-beta.20
  - @workflow/web@4.1.0-beta.47

## 4.2.0-beta.76

### Patch Changes

- Updated dependencies [[`ef2218a`](https://github.com/vercel/workflow/commit/ef2218ab22310afa04e4e1709906a86969126e52), [`74c4cdb`](https://github.com/vercel/workflow/commit/74c4cdb6519802e3d56760e971507ffb93bc945b)]:
  - @workflow/world-local@4.1.0-beta.49
  - @workflow/world-vercel@4.1.0-beta.47
  - @workflow/web@4.1.0-beta.47
  - @workflow/core@4.2.0-beta.76
  - @workflow/builders@4.0.1-beta.67

## 4.2.0-beta.75

### Patch Changes

- Updated dependencies [[`a98f8de`](https://github.com/vercel/workflow/commit/a98f8de53f1af222cccea6d091b68d544957b4e3), [`d38114b`](https://github.com/vercel/workflow/commit/d38114bff1c0a786e103b3da8c2d9afc93b41fbe), [`6dc1b78`](https://github.com/vercel/workflow/commit/6dc1b785822af5c1dc3b4a2a9b1dcb7f626cf5ff), [`329cdb3`](https://github.com/vercel/workflow/commit/329cdb3e1b55e3a2e8eb6b5befff598d7184bd78)]:
  - @workflow/world@4.1.0-beta.15
  - @workflow/core@4.2.0-beta.75
  - @workflow/world-local@4.1.0-beta.48
  - @workflow/builders@4.0.1-beta.66
  - @workflow/errors@4.1.0-beta.20
  - @workflow/web@4.1.0-beta.46
  - @workflow/world-vercel@4.1.0-beta.46

## 4.2.0-beta.74

### Patch Changes

- Updated dependencies [[`a3b7c48`](https://github.com/vercel/workflow/commit/a3b7c480e058e9070d2ecb8b84b38bbf2081840a), [`c488877`](https://github.com/vercel/workflow/commit/c488877727d693e761ecbaae1e86bac4fb1f1e2c), [`62ff600`](https://github.com/vercel/workflow/commit/62ff6004f6f5c1b7b93099470a0097d8a81a42ee), [`bd1f7e4`](https://github.com/vercel/workflow/commit/bd1f7e4b4c45750f9b8a3f37057076f2e69a5c07), [`4f646e3`](https://github.com/vercel/workflow/commit/4f646e3d58d27a5777922519a72e352814a7ef12), [`d119c74`](https://github.com/vercel/workflow/commit/d119c740d095ae601598bc2a62e6269e06f70f3e)]:
  - @workflow/builders@4.0.1-beta.65
  - @workflow/web@4.1.0-beta.46
  - @workflow/core@4.2.0-beta.74
  - @workflow/world-local@4.1.0-beta.47

## 4.2.0-beta.73

### Patch Changes

- Updated dependencies [[`8e7083b`](https://github.com/vercel/workflow/commit/8e7083b327cc727c9a4363030be8c375f9863016), [`dab106a`](https://github.com/vercel/workflow/commit/dab106acd3556f49db295108a3cdccc8058a7b92), [`52db376`](https://github.com/vercel/workflow/commit/52db376c39ef322e8e458c0f81ccc67c9ab2b301), [`d1391e1`](https://github.com/vercel/workflow/commit/d1391e1fd9a553d87ae467ba2babdc96545d5d36), [`c739b99`](https://github.com/vercel/workflow/commit/c739b995814cbc3c67092faa481e6d3d0cabfe50), [`bb86b69`](https://github.com/vercel/workflow/commit/bb86b695c247980f3ac0fd916aad108d0c05d9be)]:
  - @workflow/core@4.2.0-beta.73
  - @workflow/web@4.1.0-beta.45
  - @workflow/builders@4.0.1-beta.64
  - @workflow/world-local@4.1.0-beta.46

## 4.2.0-beta.72

### Patch Changes

- [#1467](https://github.com/vercel/workflow/pull/1467) [`0d72b2d`](https://github.com/vercel/workflow/commit/0d72b2d363eae69d7fd1490710926153094a1e9b) Thanks [@Ralph-20](https://github.com/Ralph-20)! - Add bulk cancel (`workflow cancel --status=<status>`) and `--status` filter for `inspect runs`. Fix step I/O hydration in JSON output.

- [#1442](https://github.com/vercel/workflow/pull/1442) [`fdbe853`](https://github.com/vercel/workflow/commit/fdbe853531ed07c6844dd08fa76a3c8b86f13db5) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix WORKFLOW_LOCAL_BASE_URL not being passed to health check command

- [#1490](https://github.com/vercel/workflow/pull/1490) [`5837d57`](https://github.com/vercel/workflow/commit/5837d577c24bf5017b83dd586975dc7aeb206131) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Ensure update checks don't suggest upgrading from stable release to pre-releases

- [#1438](https://github.com/vercel/workflow/pull/1438) [`da6adf7`](https://github.com/vercel/workflow/commit/da6adf7798efa38cfbe7d30209102c11cc7643c4) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Improve display when run data has expired

- Updated dependencies [[`73a851a`](https://github.com/vercel/workflow/commit/73a851ada6a4d46ae8f022ef243ebf4ee3de2ad8), [`84599b7`](https://github.com/vercel/workflow/commit/84599b7ec5c19207082523609f1b3508a1a18bd7), [`2b80e2d`](https://github.com/vercel/workflow/commit/2b80e2de35aac170e5dc7d83a1b3f26495a0bbc9), [`fdbe853`](https://github.com/vercel/workflow/commit/fdbe853531ed07c6844dd08fa76a3c8b86f13db5), [`2ef33d2`](https://github.com/vercel/workflow/commit/2ef33d2828ac06debf04ad9cc239d70fea6a8093), [`d428d66`](https://github.com/vercel/workflow/commit/d428d66441319e612b72f9b7cf430abcf45a5ecf), [`672d919`](https://github.com/vercel/workflow/commit/672d9195a475a110a64dbaa7c5c87a24f244c11a), [`beccbc4`](https://github.com/vercel/workflow/commit/beccbc4298f434a4ffb9563c4f832f2230016f40), [`77fd9ad`](https://github.com/vercel/workflow/commit/77fd9ad3556544a0efd7d6c4d00eedfc03dc10e5), [`78f1b0e`](https://github.com/vercel/workflow/commit/78f1b0e19f2ac1a621020bc9fa5dec778f3b0fd9), [`da6adf7`](https://github.com/vercel/workflow/commit/da6adf7798efa38cfbe7d30209102c11cc7643c4), [`aee035f`](https://github.com/vercel/workflow/commit/aee035f94483ef3b842bb557e8c5b167dd0536c4), [`741661b`](https://github.com/vercel/workflow/commit/741661b0bb07d2e3d3be1c51ed905468f1e8b93f), [`5010ebe`](https://github.com/vercel/workflow/commit/5010ebe7c5f8e2f4921e99cc22c7360ae0d49097), [`992d768`](https://github.com/vercel/workflow/commit/992d768f8026846bc2587892fc06e998d8c1fd8e), [`01bbe66`](https://github.com/vercel/workflow/commit/01bbe66d5a60d50d71f5b1c82b002ca7fc6f8e0b), [`6cce021`](https://github.com/vercel/workflow/commit/6cce021503b80db49fea1d0085ecb304678cfc8a), [`2b07294`](https://github.com/vercel/workflow/commit/2b072943134e8655afe8b3c2dfe535307b7a1a8b), [`977b7e9`](https://github.com/vercel/workflow/commit/977b7e97edabd9b4fb800a5f6e1037dc78ca3c61)]:
  - @workflow/errors@4.1.0-beta.19
  - @workflow/core@4.2.0-beta.72
  - @workflow/web@4.1.0-beta.44
  - @workflow/world-local@4.1.0-beta.45
  - @workflow/world-vercel@4.1.0-beta.45
  - @workflow/builders@4.0.1-beta.63
  - @workflow/swc-plugin@4.1.0-beta.21
  - @workflow/world@4.1.0-beta.14

## 4.2.0-beta.71

### Patch Changes

- Updated dependencies [[`02ea057`](https://github.com/vercel/workflow/commit/02ea0574422b342e6a467de073e003b73e099830), [`97e4384`](https://github.com/vercel/workflow/commit/97e43846f000f8ef0ea2f237a5c4cc696423e0f0), [`d6e8727`](https://github.com/vercel/workflow/commit/d6e8727a948ce60d15af635763239d8321cd7cee), [`5d95abf`](https://github.com/vercel/workflow/commit/5d95abf9413462e82759bf68ab985e794ce05756), [`dcb0761`](https://github.com/vercel/workflow/commit/dcb07617be46b83ce74a4932bf121b20cd3de597), [`3cc2943`](https://github.com/vercel/workflow/commit/3cc29431b266832dd3d9b735da455d2b11612ea7), [`2f0772d`](https://github.com/vercel/workflow/commit/2f0772d3df4983de2f6618054379a496ade4ec5a), [`7b9b3c1`](https://github.com/vercel/workflow/commit/7b9b3c1a484a4effff2190ac9899a2608704f375), [`a2c0c7e`](https://github.com/vercel/workflow/commit/a2c0c7e6d9d7349bd49aac6e6ea072c68efb7620), [`0f07403`](https://github.com/vercel/workflow/commit/0f074030a408078e7db0ae0e494f64125d7444e4), [`2cc42cb`](https://github.com/vercel/workflow/commit/2cc42cb8a934532d9ce5b05185322a2f9ce76024), [`e902980`](https://github.com/vercel/workflow/commit/e9029807733d6a7dba76626ae61bd751e9a18fbe), [`94c14c7`](https://github.com/vercel/workflow/commit/94c14c746b3218d13a5e2a7936c8cef505e7be08), [`f52afe7`](https://github.com/vercel/workflow/commit/f52afe77fffb981dd8812b84b39c2ecab2288f43)]:
  - @workflow/world-local@4.1.0-beta.44
  - @workflow/core@4.2.0-beta.71
  - @workflow/world-vercel@4.1.0-beta.44
  - @workflow/swc-plugin@4.1.0-beta.20
  - @workflow/builders@4.0.1-beta.62
  - @workflow/world@4.1.0-beta.13
  - @workflow/web@4.1.0-beta.43
  - @workflow/errors@4.1.0-beta.18

## 4.2.0-beta.70

### Patch Changes

- [#1343](https://github.com/vercel/workflow/pull/1343) [`3c3f80a`](https://github.com/vercel/workflow/commit/3c3f80a1f0e00878bd6550a39af59e305c035706) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix `-e` short flag collision between `--endpoint` and `--env` in health command

- [#1350](https://github.com/vercel/workflow/pull/1350) [`9f3551c`](https://github.com/vercel/workflow/commit/9f3551caec933679bbb733495422dc6899bbe2bc) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Support `WORKFLOW_NO_UPDATE_CHECK=1` env var to skip the npm registry version check on startup

- Updated dependencies [[`7df1385`](https://github.com/vercel/workflow/commit/7df13854f85529929ff1187fe831f4dbc51b9121), [`73c12f1`](https://github.com/vercel/workflow/commit/73c12f14dabb465e2074e2aebbcd231a4d91bc09), [`5c6ae60`](https://github.com/vercel/workflow/commit/5c6ae607a58d200fbad673821728a1a39684dfd9), [`9feebee`](https://github.com/vercel/workflow/commit/9feebee15c7c35843b99254b23a2f7743ea3f8c6), [`58e67ce`](https://github.com/vercel/workflow/commit/58e67ce11bd69b982214e2734363fa7fd252f5f6), [`d6da7ec`](https://github.com/vercel/workflow/commit/d6da7ecca0fbf94d3331ce3bd7d28644a4f5cc3f)]:
  - @workflow/core@4.2.0-beta.70
  - @workflow/web@4.1.0-beta.42
  - @workflow/world-local@4.1.0-beta.43
  - @workflow/builders@4.0.1-beta.61

## 4.2.0-beta.69

### Patch Changes

- Updated dependencies [[`825417a`](https://github.com/vercel/workflow/commit/825417acbaf7f721259427ecf4b7bc2a0e5cbef7), [`825417a`](https://github.com/vercel/workflow/commit/825417acbaf7f721259427ecf4b7bc2a0e5cbef7), [`825417a`](https://github.com/vercel/workflow/commit/825417acbaf7f721259427ecf4b7bc2a0e5cbef7), [`fb5a500`](https://github.com/vercel/workflow/commit/fb5a500eadba80efdef75e3ccf6e85e957820f38), [`3648109`](https://github.com/vercel/workflow/commit/3648109861f1fbfe24101936dc35c9a36650b7e2), [`d5bc418`](https://github.com/vercel/workflow/commit/d5bc418816748ab2b5109ca7b082f3be427c326b), [`d5ae817`](https://github.com/vercel/workflow/commit/d5ae81786303554bbee0e9fa939c92274a883d18), [`d72c822`](https://github.com/vercel/workflow/commit/d72c82220f0c56bb26edbc918e485b8bd14c959b), [`d5bc418`](https://github.com/vercel/workflow/commit/d5bc418816748ab2b5109ca7b082f3be427c326b)]:
  - @workflow/core@4.2.0-beta.69
  - @workflow/world-vercel@4.1.0-beta.43
  - @workflow/world@4.1.0-beta.12
  - @workflow/world-local@4.1.0-beta.42
  - @workflow/web@4.1.0-beta.41
  - @workflow/builders@4.0.1-beta.60
  - @workflow/swc-plugin@4.1.0-beta.19
  - @workflow/errors@4.1.0-beta.18

## 4.2.0-beta.68

### Patch Changes

- [#1261](https://github.com/vercel/workflow/pull/1261) [`887cc2b`](https://github.com/vercel/workflow/commit/887cc2bd55b904c696083d87ab32a9fc03d619a8) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Refactor trace viewer to build spans entirely from events instead of fetching Steps and Hooks as separate resources.

- [#1304](https://github.com/vercel/workflow/pull/1304) [`83dbd46`](https://github.com/vercel/workflow/commit/83dbd46456a8dbfc89efd87895929cbb813feda3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Stop reading `WORKFLOW_VERCEL_*` env vars at runtime to prevent unintended proxy routing

- [#1309](https://github.com/vercel/workflow/pull/1309) [`d842ce1`](https://github.com/vercel/workflow/commit/d842ce1c435049805233cf218aa9ce07d9cab130) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Surface HTTP errors (e.g. 429 rate limit) from encryption key fetch instead of silently falling back to encrypted placeholders. Add 429 to the status text map.

- Updated dependencies [[`887cc2b`](https://github.com/vercel/workflow/commit/887cc2bd55b904c696083d87ab32a9fc03d619a8), [`83dbd46`](https://github.com/vercel/workflow/commit/83dbd46456a8dbfc89efd87895929cbb813feda3), [`9781afb`](https://github.com/vercel/workflow/commit/9781afb490b252f5656e5d48c61c038c3aef794f), [`4a6ddd8`](https://github.com/vercel/workflow/commit/4a6ddd82c0fc1b3768f3a10befad77f43e81036e), [`854a25f`](https://github.com/vercel/workflow/commit/854a25f9103f5f3a5769dec6e3e5c6b98ed119b0), [`aa2f581`](https://github.com/vercel/workflow/commit/aa2f581b488baf929a784f289a81e21c39ccb5a6), [`d842ce1`](https://github.com/vercel/workflow/commit/d842ce1c435049805233cf218aa9ce07d9cab130), [`33101a2`](https://github.com/vercel/workflow/commit/33101a229207bafe869fb73686c6bfcc59ab25b0)]:
  - @workflow/web@4.1.0-beta.40
  - @workflow/core@4.2.0-beta.68
  - @workflow/world-vercel@4.1.0-beta.42
  - @workflow/world-local@4.1.0-beta.41
  - @workflow/builders@4.0.1-beta.59

## 4.2.0-beta.67

### Patch Changes

- Updated dependencies [[`c71befe`](https://github.com/vercel/workflow/commit/c71befe8ec73765e67b7f2e0627251643ab245d4), [`36a901d`](https://github.com/vercel/workflow/commit/36a901d2d2f2ba37ec024073a7dd39a094b9e9c0), [`5e4ef65`](https://github.com/vercel/workflow/commit/5e4ef657cf34c04d6d12b9823fb7fca8885c2f90), [`d8daa2a`](https://github.com/vercel/workflow/commit/d8daa2a9a95e2d01a4e6fee4e8dde51d82db762d)]:
  - @workflow/core@4.2.0-beta.67
  - @workflow/web@4.1.0-beta.39
  - @workflow/world@4.1.0-beta.11
  - @workflow/world-local@4.1.0-beta.40
  - @workflow/world-vercel@4.1.0-beta.41
  - @workflow/builders@4.0.1-beta.58
  - @workflow/errors@4.1.0-beta.18

## 4.2.0-beta.66

### Patch Changes

- Updated dependencies [[`8b5a388`](https://github.com/vercel/workflow/commit/8b5a388a9451d7c7460481f0889da5037bd90893), [`dff00c9`](https://github.com/vercel/workflow/commit/dff00c94008f60cbfb4a398f2b98101d80ee8377)]:
  - @workflow/core@4.2.0-beta.66
  - @workflow/world-local@4.1.0-beta.39
  - @workflow/world-vercel@4.1.0-beta.40
  - @workflow/builders@4.0.1-beta.57
  - @workflow/web@4.1.0-beta.38

## 4.2.0-beta.65

### Patch Changes

- [#1277](https://github.com/vercel/workflow/pull/1277) [`97932d3`](https://github.com/vercel/workflow/commit/97932d3086b4b7c339e612fb6cac0ffda74545e3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix encrypted stream inspection: move deserialization/decryption client-side, add --decrypt support to CLI

- [#1273](https://github.com/vercel/workflow/pull/1273) [`11dcb64`](https://github.com/vercel/workflow/commit/11dcb646d33e7a2b251d9388c2c8ecdd6aca73f7) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Quiet dotenv logs

- Updated dependencies [[`1eaff36`](https://github.com/vercel/workflow/commit/1eaff36f197bcaefacac2e89a08c90e735a67644), [`97932d3`](https://github.com/vercel/workflow/commit/97932d3086b4b7c339e612fb6cac0ffda74545e3), [`456c1aa`](https://github.com/vercel/workflow/commit/456c1aa455d9d391a954b25e3d86ee9b06ad2f30), [`11dcb64`](https://github.com/vercel/workflow/commit/11dcb646d33e7a2b251d9388c2c8ecdd6aca73f7)]:
  - @workflow/web@4.1.0-beta.38
  - @workflow/world-local@4.1.0-beta.38
  - @workflow/world@4.1.0-beta.10
  - @workflow/world-vercel@4.1.0-beta.39
  - @workflow/core@4.2.0-beta.65
  - @workflow/errors@4.1.0-beta.18
  - @workflow/builders@4.0.1-beta.56

## 4.2.0-beta.64

### Patch Changes

- [#1263](https://github.com/vercel/workflow/pull/1263) [`b68ed63`](https://github.com/vercel/workflow/commit/b68ed630ec2fadd9d6ed9935cafeead64aed5071) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix CLI 401 errors by reading orgId from per-project entry in repo.json for newer Vercel CLI versions

- [#1256](https://github.com/vercel/workflow/pull/1256) [`bbe40ff`](https://github.com/vercel/workflow/commit/bbe40ff00a5e372b040aec8fc7640c54d08c5636) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add encryption-aware o11y for CLI and web UI

- Updated dependencies [[`adfe8b6`](https://github.com/vercel/workflow/commit/adfe8b6b1123ce581aa9572bae91b8d7f9cdc53d), [`adfe8b6`](https://github.com/vercel/workflow/commit/adfe8b6b1123ce581aa9572bae91b8d7f9cdc53d), [`7618ac3`](https://github.com/vercel/workflow/commit/7618ac36c203d04e39513953e3b22a13b0c70829), [`860531d`](https://github.com/vercel/workflow/commit/860531d182d74547acd12784cb825bb41c1a9342), [`02f706f`](https://github.com/vercel/workflow/commit/02f706fb99d2ffa3f862698092d17cedbdb8ba02), [`60bc9d5`](https://github.com/vercel/workflow/commit/60bc9d5cb1022e169266884f4bcdd0fb99c45679), [`bbe40ff`](https://github.com/vercel/workflow/commit/bbe40ff00a5e372b040aec8fc7640c54d08c5636), [`30e24d4`](https://github.com/vercel/workflow/commit/30e24d441e735635ffa4522198e6905d0e51e175), [`a7ae7e9`](https://github.com/vercel/workflow/commit/a7ae7e9a612905c911a59b631d62856d31333aeb)]:
  - @workflow/errors@4.1.0-beta.18
  - @workflow/core@4.2.0-beta.64
  - @workflow/world-local@4.1.0-beta.37
  - @workflow/world-vercel@4.1.0-beta.38
  - @workflow/world@4.1.0-beta.9
  - @workflow/web@4.1.0-beta.37
  - @workflow/builders@4.0.1-beta.55

## 4.1.0-beta.63

### Patch Changes

- [#1230](https://github.com/vercel/workflow/pull/1230) [`a9fea91`](https://github.com/vercel/workflow/commit/a9fea9132ef3797dbda7683c36cc86ff2bd82f1f) Thanks [@ijjk](https://github.com/ijjk)! - Fix deferred build mode for Next.js

- Updated dependencies [[`4ab4412`](https://github.com/vercel/workflow/commit/4ab4412ae6f4a64eb29fcb0e445f0b3314aa3b9b), [`809339b`](https://github.com/vercel/workflow/commit/809339ba1c8362529c9fc198f7921f19fe91f233), [`2b1c2bd`](https://github.com/vercel/workflow/commit/2b1c2bd8e6b384334fbeb7ede8f517a5ca683716), [`a9fea91`](https://github.com/vercel/workflow/commit/a9fea9132ef3797dbda7683c36cc86ff2bd82f1f)]:
  - @workflow/core@4.1.0-beta.63
  - @workflow/builders@4.0.1-beta.54
  - @workflow/world-vercel@4.1.0-beta.37
  - @workflow/web@4.1.0-beta.36

## 4.1.0-beta.62

### Patch Changes

- [#1217](https://github.com/vercel/workflow/pull/1217) [`e55c636`](https://github.com/vercel/workflow/commit/e55c63678b15b6687cc77efca705ee9fb40fabc3) Thanks [@pranaygp](https://github.com/pranaygp)! - Upgrade dependencies across all packages

- Updated dependencies [[`6f2cbcd`](https://github.com/vercel/workflow/commit/6f2cbcda9df55809f2dab15a05b0b72a78095439), [`1cfb8b1`](https://github.com/vercel/workflow/commit/1cfb8b12e7d40e372d6e223add1518cd62fa0b5f), [`274ea8b`](https://github.com/vercel/workflow/commit/274ea8b5720c03d564b567edb3fdeb97a6db2c09), [`02681dc`](https://github.com/vercel/workflow/commit/02681dce4a504ff236c81a1ee976d2b04d1a5774), [`f3b2e08`](https://github.com/vercel/workflow/commit/f3b2e08adbb259670445bba7cea79cfd25c8370b), [`028a828`](https://github.com/vercel/workflow/commit/028a828de113f8b07f9bb70d91f75e97162ab37d), [`e55c636`](https://github.com/vercel/workflow/commit/e55c63678b15b6687cc77efca705ee9fb40fabc3)]:
  - @workflow/core@4.1.0-beta.62
  - @workflow/world-vercel@4.1.0-beta.36
  - @workflow/world-local@4.1.0-beta.36
  - @workflow/builders@4.0.1-beta.53
  - @workflow/utils@4.1.0-beta.13
  - @workflow/world@4.1.0-beta.8
  - @workflow/web@4.1.0-beta.36
  - @workflow/errors@4.1.0-beta.17

## 4.1.0-beta.61

### Patch Changes

- Updated dependencies [[`b224521`](https://github.com/vercel/workflow/commit/b224521cb09c6741423783140c50148b0c98d227), [`49d1b6d`](https://github.com/vercel/workflow/commit/49d1b6d57ea6b9283eef7158dcd4881caa18091f), [`f5ea16f`](https://github.com/vercel/workflow/commit/f5ea16fbf5ba046e0e7a6e7ef95d6305abfd1768), [`70223a9`](https://github.com/vercel/workflow/commit/70223a9091494ba1db56784e29e5bc92c78a89e0), [`e1a2f47`](https://github.com/vercel/workflow/commit/e1a2f475aa3258ee9e36e0694f73dbbe72b49fbe), [`f0823dc`](https://github.com/vercel/workflow/commit/f0823dc79b74e76176974230cecaccd705a8da75), [`c614456`](https://github.com/vercel/workflow/commit/c6144564eab0168bbb00350839c04f5f009dcd8e), [`a0b99c8`](https://github.com/vercel/workflow/commit/a0b99c8ec83ef602947b671aa9aed91720c170ce), [`d99ca9c`](https://github.com/vercel/workflow/commit/d99ca9cfed4fafd43853f89f8a4939ed3d240e20), [`1f9a67c`](https://github.com/vercel/workflow/commit/1f9a67c759fa6444f6f652692871e8bc7e65ea71), [`b06e491`](https://github.com/vercel/workflow/commit/b06e491a4769724435afff66724ac9e275fe11df)]:
  - @workflow/world-vercel@4.1.0-beta.35
  - @workflow/core@4.1.0-beta.61
  - @workflow/web@4.1.0-beta.35
  - @workflow/world@4.1.0-beta.7
  - @workflow/builders@4.0.1-beta.52
  - @workflow/errors@4.1.0-beta.16
  - @workflow/world-local@4.1.0-beta.35

## 4.1.0-beta.60

### Patch Changes

- Updated dependencies [[`c1cd9a3`](https://github.com/vercel/workflow/commit/c1cd9a3bc7a0ef953d588c8fe4f21a32f80711b3)]:
  - @workflow/core@4.1.0-beta.60
  - @workflow/builders@4.0.1-beta.51
  - @workflow/web@4.1.0-beta.34

## 4.1.0-beta.59

### Patch Changes

- Updated dependencies [[`c75de97`](https://github.com/vercel/workflow/commit/c75de973fd41d2a1d0391d965b61210a9fb7c86c), [`b65bb07`](https://github.com/vercel/workflow/commit/b65bb072b540e9e5fb6bc3f72c4132667cc60277), [`b65bb07`](https://github.com/vercel/workflow/commit/b65bb072b540e9e5fb6bc3f72c4132667cc60277), [`b65bb07`](https://github.com/vercel/workflow/commit/b65bb072b540e9e5fb6bc3f72c4132667cc60277)]:
  - @workflow/core@4.1.0-beta.59
  - @workflow/world-vercel@4.1.0-beta.34
  - @workflow/world@4.1.0-beta.6
  - @workflow/builders@4.0.1-beta.50
  - @workflow/web@4.1.0-beta.34
  - @workflow/errors@4.1.0-beta.16
  - @workflow/world-local@4.1.0-beta.34

## 4.1.0-beta.58

### Patch Changes

- [#978](https://github.com/vercel/workflow/pull/978) [`0d5323c`](https://github.com/vercel/workflow/commit/0d5323c0a7e760f1fa3741cf249c19f59e9ddfbe) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Refactor serialization code to be asynchronous

- [#1081](https://github.com/vercel/workflow/pull/1081) [`5487983`](https://github.com/vercel/workflow/commit/54879835f390299f9249523e0488bbdca708fb68) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Call `World.close()` after CLI commands complete so the process exits cleanly without relying on `process.exit()`

- [#979](https://github.com/vercel/workflow/pull/979) [`6e72b29`](https://github.com/vercel/workflow/commit/6e72b295e71c1a9e0a91dbe1137eca7b88227e1f) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `World.getEncryptionKeyForRun()` and thread encryption key through serialization layer

- [#999](https://github.com/vercel/workflow/pull/999) [`ea3254e`](https://github.com/vercel/workflow/commit/ea3254e7ce28cef6b9b829ac7ad379921dd41ed9) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Separate project ID and project name into distinct env vars (WORKFLOW_VERCEL_PROJECT and WORKFLOW_VERCEL_PROJECT_NAME)

- [#1043](https://github.com/vercel/workflow/pull/1043) [`8cfb438`](https://github.com/vercel/workflow/commit/8cfb43808b2c7fc9435cd514652baf10ad924c45) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Use `@vercel/cli-auth` for auth token reading and OAuth refresh

- [#1078](https://github.com/vercel/workflow/pull/1078) [`262ef3a`](https://github.com/vercel/workflow/commit/262ef3a21a223ea0047c5b2840228d3216afb2df) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix CLI missing `specVersion` in "run_cancelled" event payload

- Updated dependencies [[`0d5323c`](https://github.com/vercel/workflow/commit/0d5323c0a7e760f1fa3741cf249c19f59e9ddfbe), [`7046610`](https://github.com/vercel/workflow/commit/704661078f6d6065f9b5dcd28c0b98ae91034143), [`c2b4fe9`](https://github.com/vercel/workflow/commit/c2b4fe9906fd0845fef646669034cd203d97a18d), [`6e72b29`](https://github.com/vercel/workflow/commit/6e72b295e71c1a9e0a91dbe1137eca7b88227e1f), [`ea3254e`](https://github.com/vercel/workflow/commit/ea3254e7ce28cef6b9b829ac7ad379921dd41ed9), [`1c11573`](https://github.com/vercel/workflow/commit/1c1157340d88c60c7c80c0789c111050b809ab77), [`5213309`](https://github.com/vercel/workflow/commit/5213309073440515de5212c61538e73d267461e7), [`9f77380`](https://github.com/vercel/workflow/commit/9f773804937cf94fc65a2141c4a45b429771a5cb), [`852e3f1`](https://github.com/vercel/workflow/commit/852e3f1788f7a9aff638b322af4c8b1a7135c17e), [`29347b7`](https://github.com/vercel/workflow/commit/29347b79eae8181d02ed1e52183983adc56425fd), [`5e06a7c`](https://github.com/vercel/workflow/commit/5e06a7c8332042a4835fa0e469e1031fec742668), [`5487983`](https://github.com/vercel/workflow/commit/54879835f390299f9249523e0488bbdca708fb68), [`5487983`](https://github.com/vercel/workflow/commit/54879835f390299f9249523e0488bbdca708fb68)]:
  - @workflow/core@4.1.0-beta.58
  - @workflow/world-vercel@4.1.0-beta.33
  - @workflow/errors@4.1.0-beta.16
  - @workflow/world@4.1.0-beta.5
  - @workflow/web@4.1.0-beta.34
  - @workflow/builders@4.0.1-beta.49
  - @workflow/world-local@4.1.0-beta.33

## 4.1.0-beta.57

### Patch Changes

- Updated dependencies []:
  - @workflow/core@4.1.0-beta.57
  - @workflow/builders@4.0.1-beta.48
  - @workflow/web@4.1.0-beta.33

## 4.1.0-beta.56

### Patch Changes

- [#1005](https://github.com/vercel/workflow/pull/1005) [`7653e6b`](https://github.com/vercel/workflow/commit/7653e6bfdbfe29624a5cbc1477b299f6aca3a0f0) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Migrate `@workflow/web` from Next.js to React Router v7 framework mode. Replace child process spawning in the CLI with in-process Express server. Switch RPC transport from JSON to CBOR.

- [#1015](https://github.com/vercel/workflow/pull/1015) [`c56dc38`](https://github.com/vercel/workflow/commit/c56dc3848ecf3e188f876dc4cb7861df185bd4fb) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Extract browser-safe serialization format from `@workflow/core` and split o11y hydration by environment. Data hydration now happens client-side in the browser, enabling future e2e encryption support.

- Updated dependencies [[`7653e6b`](https://github.com/vercel/workflow/commit/7653e6bfdbfe29624a5cbc1477b299f6aca3a0f0), [`c56dc38`](https://github.com/vercel/workflow/commit/c56dc3848ecf3e188f876dc4cb7861df185bd4fb), [`d7d005b`](https://github.com/vercel/workflow/commit/d7d005b54b621214720518a2a19aa2cadfa23d47), [`8d117cd`](https://github.com/vercel/workflow/commit/8d117cd219faac53ffa90db8628defd3d7a8160d), [`94760b4`](https://github.com/vercel/workflow/commit/94760b4640dde4ed84ff0932994ce9a47b1954ad), [`63caf93`](https://github.com/vercel/workflow/commit/63caf931380b8211f1948cf44eac7532f33e660d), [`63caf93`](https://github.com/vercel/workflow/commit/63caf931380b8211f1948cf44eac7532f33e660d), [`dc2dc6a`](https://github.com/vercel/workflow/commit/dc2dc6ac7908e57be9ab34140addfe98a9246fc7)]:
  - @workflow/web@4.1.0-beta.33
  - @workflow/core@4.1.0-beta.56
  - @workflow/builders@4.0.1-beta.47
  - @workflow/world-local@4.1.0-beta.32

## 4.1.0-beta.55

### Patch Changes

- Updated dependencies [[`3d770d5`](https://github.com/vercel/workflow/commit/3d770d53855ce7c8522d4f0afbdbc123eae6c1ee), [`054e40c`](https://github.com/vercel/workflow/commit/054e40c91be615809c71d3ad29573c78c4491825), [`a5935ab`](https://github.com/vercel/workflow/commit/a5935abec7c7e57b2a89c629203d567cd7ac76a7), [`fc4cad6`](https://github.com/vercel/workflow/commit/fc4cad68088b0f4fa4e5eeb828e2af29e05d4fe1), [`1adcc6a`](https://github.com/vercel/workflow/commit/1adcc6a618562e0b31ae53d10f9f6aa797107705), [`56f2221`](https://github.com/vercel/workflow/commit/56f22219b338a5a2c29466798a5ad36a6a450498)]:
  - @workflow/builders@4.0.1-beta.46
  - @workflow/utils@4.1.0-beta.12
  - @workflow/core@4.1.0-beta.55
  - @workflow/swc-plugin@4.1.0-beta.18
  - @workflow/errors@4.1.0-beta.15
  - @workflow/world@4.1.0-beta.4
  - @workflow/world-vercel@4.1.0-beta.32
  - @workflow/web@4.1.0-beta.32
  - @workflow/world-local@4.1.0-beta.31

## 4.1.0-beta.54

### Patch Changes

- Updated dependencies [[`2d1d69f`](https://github.com/vercel/workflow/commit/2d1d69f4ca7be9cf6d01aa2dfb9b031d74ba166c), [`fcfaf8b`](https://github.com/vercel/workflow/commit/fcfaf8bbaa912b1767c646592e539d5f98cd1e9c), [`d9e9859`](https://github.com/vercel/workflow/commit/d9e98590fae17fd090e0be4f0b54bbaa80c7be69), [`aa448c2`](https://github.com/vercel/workflow/commit/aa448c29b4c3853985eaa1bcbbf2029165edade3), [`ef23b0b`](https://github.com/vercel/workflow/commit/ef23b0be770bbb5ccca015fb2564953fe6a761d7), [`f7fd88e`](https://github.com/vercel/workflow/commit/f7fd88ea963e127e62c8d527dcfdb895ba646fc2), [`fcfaf8b`](https://github.com/vercel/workflow/commit/fcfaf8bbaa912b1767c646592e539d5f98cd1e9c)]:
  - @workflow/builders@4.0.1-beta.45
  - @workflow/core@4.1.0-beta.54
  - @workflow/world@4.1.0-beta.3
  - @workflow/world-vercel@4.1.0-beta.31
  - @workflow/swc-plugin@4.1.0-beta.17
  - @workflow/web@4.1.0-beta.32
  - @workflow/errors@4.1.0-beta.14
  - @workflow/world-local@4.1.0-beta.30

## 4.1.0-beta.53

### Patch Changes

- Updated dependencies [[`0ce46b9`](https://github.com/vercel/workflow/commit/0ce46b91d9c8ca3349f43cdf3a5d75a948d6f5ad), [`35a9f0c`](https://github.com/vercel/workflow/commit/35a9f0cb0360ffc48c8a8e7db3a299924ab48375), [`f090de1`](https://github.com/vercel/workflow/commit/f090de1eb48ad8ec3fd776e9d084310d56a7ac29), [`79e988f`](https://github.com/vercel/workflow/commit/79e988fa85f0ebdd5c8913b8de84e01c55d020b9), [`2453b29`](https://github.com/vercel/workflow/commit/2453b29426d79497076bc910c23cac887beefc0d), [`b9c782d`](https://github.com/vercel/workflow/commit/b9c782d75f5452265764cd36d5e306060f8703c3), [`c54ba21`](https://github.com/vercel/workflow/commit/c54ba21c19040577ed95f6264a2670f190e1d1d3), [`b5296a7`](https://github.com/vercel/workflow/commit/b5296a7a32b9037aa03c71d87e785fa2d5384a11), [`c1d7c8d`](https://github.com/vercel/workflow/commit/c1d7c8dbb44afb7434acb07fee500ecaa1224fb0), [`e0061b8`](https://github.com/vercel/workflow/commit/e0061b861d0e3c3dc15853aed331fb1bbab71408), [`38e8d55`](https://github.com/vercel/workflow/commit/38e8d5571d2ee4b80387943f8f39a93b6e4bc751), [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6), [`73bf7be`](https://github.com/vercel/workflow/commit/73bf7be925a8ffc0c6fce0cc75b6092243882088), [`efb33b2`](https://github.com/vercel/workflow/commit/efb33b2b5edf6ccb1ec2f02f1d99f2a009333780), [`661724c`](https://github.com/vercel/workflow/commit/661724c01e78691abad26fa99bd44f254a70f2dd), [`8114792`](https://github.com/vercel/workflow/commit/8114792600a851fbf14cf41f8340e646aef36368), [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6), [`79e988f`](https://github.com/vercel/workflow/commit/79e988fa85f0ebdd5c8913b8de84e01c55d020b9), [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6)]:
  - @workflow/world@4.1.0-beta.2
  - @workflow/world-vercel@4.1.0-beta.30
  - @workflow/world-local@4.1.0-beta.29
  - @workflow/core@4.1.0-beta.53
  - @workflow/swc-plugin@4.1.0-beta.16
  - @workflow/builders@4.0.1-beta.44
  - @workflow/web@4.1.0-beta.32
  - @workflow/errors@4.1.0-beta.14

## 4.1.0-beta.52

### Patch Changes

- Updated dependencies [[`e4e3281`](https://github.com/vercel/workflow/commit/e4e32812f8f181ad4db72e76f62ba1edf2477b12), [`f40532a`](https://github.com/vercel/workflow/commit/f40532a8720b9b0ecb3cf4983cbfd86065503567)]:
  - @workflow/core@4.1.0-beta.52
  - @workflow/builders@4.0.1-beta.43
  - @workflow/web@4.1.0-beta.31

## 4.1.0-beta.51

### Minor Changes

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - **BREAKING**: Storage interface is now read-only; all mutations go through `events.create()`
  - Remove `cancel`, `pause`, `resume` from `runs`
  - Remove `create`, `update` from `runs`, `steps`, `hooks`
  - Add run lifecycle events: `run_created`, `run_started`, `run_completed`, `run_failed`, `run_cancelled`
  - Add `step_created` event type
  - Remove `fatal` field from `step_failed` (terminal failure is now implicit)
  - Add `step_retrying` event with error info for retriable failures

### Patch Changes

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - Use `events.create()` for run cancellation

- [#894](https://github.com/vercel/workflow/pull/894) [`a2b688d`](https://github.com/vercel/workflow/commit/a2b688d0623ebbae117877a696c5b9b288d628fd) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix resuming v1 hooks and cancelling/re-running v1 runs from a v2 UI or runtime

- [#814](https://github.com/vercel/workflow/pull/814) [`b16a682`](https://github.com/vercel/workflow/commit/b16a6828af36a2d5adb38fb6a6d1253657001ac8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Move "parse-name" into the `utils` package

- [#833](https://github.com/vercel/workflow/pull/833) [`bd8116d`](https://github.com/vercel/workflow/commit/bd8116d40bf8d662537bf015d2861f6d1768d69e) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Remove `skipProxy` and `baseUrl` config options, simplify proxy logic

- [#853](https://github.com/vercel/workflow/pull/853) [`1060f9d`](https://github.com/vercel/workflow/commit/1060f9d04a372bf6de6c5c3d52063bcc22dba6e8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - **BREAKING CHANGE**: Change user input/output to be binary data (Uint8Array) at the World interface

  This is part of specVersion 2 changes where serialization of workflow and step data uses binary format instead of JSON arrays. This allows the workflow client to be fully responsible for the data serialization format and enables future enhancements such as encryption and compression without the World implementation needing to care about the underlying data representation.

- Updated dependencies [[`50f50f4`](https://github.com/vercel/workflow/commit/50f50f44d79a3cf1102173ff1865cd8a01723ea3), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`0b5cc48`](https://github.com/vercel/workflow/commit/0b5cc4814094ecb8ec5be8eb5339c04d97b55c8b), [`26a9833`](https://github.com/vercel/workflow/commit/26a98330d478dd76192d9897b5a0cc0cf3feacd7), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`b59559b`](https://github.com/vercel/workflow/commit/b59559be70e839025680c4f9873d521170e48e1c), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`13d4cee`](https://github.com/vercel/workflow/commit/13d4ceef74e1e51b6471df6a85f03b3b967c3da4), [`4ad3fcd`](https://github.com/vercel/workflow/commit/4ad3fcd0a362f3d83a6c272dec6362fe9a562c63), [`a2b688d`](https://github.com/vercel/workflow/commit/a2b688d0623ebbae117877a696c5b9b288d628fd), [`244b94a`](https://github.com/vercel/workflow/commit/244b94a0665087ece694ae881a17d6aaa0ca0a7f), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`1f684df`](https://github.com/vercel/workflow/commit/1f684df6b7b9cd322d5f1aa4a70dcaa3e07c7986), [`81c5a83`](https://github.com/vercel/workflow/commit/81c5a835ae647cd94d88ccec8c3b037acdfb6598), [`b4113da`](https://github.com/vercel/workflow/commit/b4113da9541f3cebf1605d753374025f95259bf8), [`b16a682`](https://github.com/vercel/workflow/commit/b16a6828af36a2d5adb38fb6a6d1253657001ac8), [`bd8116d`](https://github.com/vercel/workflow/commit/bd8116d40bf8d662537bf015d2861f6d1768d69e), [`1060f9d`](https://github.com/vercel/workflow/commit/1060f9d04a372bf6de6c5c3d52063bcc22dba6e8), [`00c7961`](https://github.com/vercel/workflow/commit/00c7961ecb09418d6c23e1346a1b6569eb66a6bf), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`b973b8d`](https://github.com/vercel/workflow/commit/b973b8d00f6459fa675ee9875642e49760f68879), [`57f6376`](https://github.com/vercel/workflow/commit/57f637653d3790b9a77b2cd072bcf02fa6b61d74), [`60a9b76`](https://github.com/vercel/workflow/commit/60a9b7661a86b6bd44c25cddf68cadf0515f195e), [`c45bc3f`](https://github.com/vercel/workflow/commit/c45bc3fd15ca201ee568cf7789ff1467cf7ba566), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae)]:
  - @workflow/builders@4.0.1-beta.42
  - @workflow/world@4.1.0-beta.1
  - @workflow/world-local@4.1.0-beta.28
  - @workflow/errors@4.1.0-beta.14
  - @workflow/world-vercel@4.1.0-beta.29
  - @workflow/core@4.1.0-beta.51
  - @workflow/swc-plugin@4.1.0-beta.15
  - @workflow/utils@4.1.0-beta.11
  - @workflow/web@4.1.0-beta.31

## 4.0.1-beta.50

### Patch Changes

- [#816](https://github.com/vercel/workflow/pull/816) [`5ba82ec`](https://github.com/vercel/workflow/commit/5ba82ec4b105d11538be6ad65449986eaf945916) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `workflow health` CLI command

- Updated dependencies [[`5ba82ec`](https://github.com/vercel/workflow/commit/5ba82ec4b105d11538be6ad65449986eaf945916), [`5ba82ec`](https://github.com/vercel/workflow/commit/5ba82ec4b105d11538be6ad65449986eaf945916), [`202c524`](https://github.com/vercel/workflow/commit/202c524723932fc5342d33f4b57d26c25c7f9e64), [`5ba82ec`](https://github.com/vercel/workflow/commit/5ba82ec4b105d11538be6ad65449986eaf945916), [`f3785f0`](https://github.com/vercel/workflow/commit/f3785f04fbdf9e6199e0e42c592e3d5ba246a6c6), [`b05dbd7`](https://github.com/vercel/workflow/commit/b05dbd7525c1a4b4027a28e0f4eae9da87ea5788)]:
  - @workflow/core@4.0.1-beta.41
  - @workflow/web@4.0.1-beta.30
  - @workflow/world-local@4.0.1-beta.27
  - @workflow/world-vercel@4.0.1-beta.28
  - @workflow/builders@4.0.1-beta.41

## 4.0.1-beta.49

### Patch Changes

- [#811](https://github.com/vercel/workflow/pull/811) [`714b233`](https://github.com/vercel/workflow/commit/714b23300561ede1532c894ae770225f260365cd) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Update log message when PORT not set, and make less prominent

- Updated dependencies [[`1843704`](https://github.com/vercel/workflow/commit/1843704b83d5aaadcf1e4f5f1c73c150bd0bd2a3), [`f93e894`](https://github.com/vercel/workflow/commit/f93e894a6a95a194637dc2ea8b19e1ad0b7653eb), [`d30e5c0`](https://github.com/vercel/workflow/commit/d30e5c0249018083bdd63ac84408449003399099), [`ee7b1fd`](https://github.com/vercel/workflow/commit/ee7b1fd24483c24527d95ba1f5ad444d05b7ffcf)]:
  - @workflow/swc-plugin@4.0.1-beta.14
  - @workflow/core@4.0.1-beta.40
  - @workflow/web@4.0.1-beta.29
  - @workflow/builders@4.0.1-beta.40

## 4.0.1-beta.48

### Patch Changes

- Updated dependencies [[`344c90f`](https://github.com/vercel/workflow/commit/344c90ff9f630addc4b41f72c2296b26e61513bc), [`b729d49`](https://github.com/vercel/workflow/commit/b729d49610739ae818fd56853f8ddc557591e9a1)]:
  - @workflow/core@4.0.1-beta.39
  - @workflow/builders@4.0.1-beta.39
  - @workflow/web@4.0.1-beta.28

## 4.0.1-beta.47

### Patch Changes

- [#774](https://github.com/vercel/workflow/pull/774) [`abdca8f`](https://github.com/vercel/workflow/commit/abdca8fd526f3c83c7da7b96a0522f9552e2bd2f) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Improve display of configuration information. Fix opening of Vercel backend when using `--localUi`. Fix world caching in multi-tenant environments. Fix flicker in run table when refreshing. Improve contributor experience by adding `--observabilityCwd` flag to easily iterate on web UI from another directory. Polish navbar UI.

- Updated dependencies [[`abdca8f`](https://github.com/vercel/workflow/commit/abdca8fd526f3c83c7da7b96a0522f9552e2bd2f)]:
  - @workflow/web@4.0.1-beta.28

## 4.0.1-beta.46

### Patch Changes

- Updated dependencies [[`7906429`](https://github.com/vercel/workflow/commit/7906429541672049821ec8b74452c99868db6290), [`7906429`](https://github.com/vercel/workflow/commit/7906429541672049821ec8b74452c99868db6290), [`a2fc53a`](https://github.com/vercel/workflow/commit/a2fc53a0dc2df0648ae9e7fd59aae044a612ebcb)]:
  - @workflow/swc-plugin@4.0.1-beta.13
  - @workflow/core@4.0.1-beta.38
  - @workflow/builders@4.0.1-beta.38
  - @workflow/web@4.0.1-beta.27

## 4.0.1-beta.45

### Patch Changes

- [#765](https://github.com/vercel/workflow/pull/765) [`44dfafe`](https://github.com/vercel/workflow/commit/44dfafe3fcf0c5aa56beb86f6d428894b22d0b0c) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Read .env and .env.local files on startup

- Updated dependencies [[`adb9312`](https://github.com/vercel/workflow/commit/adb93121fc0d4790e949f79eec1c375af207bf13), [`61fdb41`](https://github.com/vercel/workflow/commit/61fdb41e1b5cd52c7b23fa3c0f3fcaa50c4189ca), [`61fdb41`](https://github.com/vercel/workflow/commit/61fdb41e1b5cd52c7b23fa3c0f3fcaa50c4189ca), [`3dd5b27`](https://github.com/vercel/workflow/commit/3dd5b2708de56e63c9dce9b3f2eafea63b0e3936), [`0aa835f`](https://github.com/vercel/workflow/commit/0aa835fe30d4d61e2d6dcde693d6fbb24be72c66), [`49f650c`](https://github.com/vercel/workflow/commit/49f650c3a79e7b9b501cb602e3c12b75a3c4fffc), [`39e5774`](https://github.com/vercel/workflow/commit/39e5774de2a4c8b6a18574aa4edaf79e9f0d655e)]:
  - @workflow/web@4.0.1-beta.27
  - @workflow/core@4.0.1-beta.37
  - @workflow/world@4.0.1-beta.13
  - @workflow/builders@4.0.1-beta.37
  - @workflow/errors@4.0.1-beta.13
  - @workflow/world-local@4.0.1-beta.26
  - @workflow/world-vercel@4.0.1-beta.27

## 4.0.1-beta.44

### Patch Changes

- [#747](https://github.com/vercel/workflow/pull/747) [`3fb57e1`](https://github.com/vercel/workflow/commit/3fb57e14c8bd3948599625bdf911b88db5842320) Thanks [@pranaygp](https://github.com/pranaygp)! - Use env variables instead of query params for world config (like WORKFLOW_TARGET_WORLD)

  **BREAKING CHANGE**: The OSS web UI is now locked to a single world and will not let you change world using query params

- Updated dependencies [[`3fb57e1`](https://github.com/vercel/workflow/commit/3fb57e14c8bd3948599625bdf911b88db5842320)]:
  - @workflow/web@4.0.1-beta.26

## 4.0.1-beta.43

### Patch Changes

- [#751](https://github.com/vercel/workflow/pull/751) [`dd3db13`](https://github.com/vercel/workflow/commit/dd3db13d5498622284ed97c1a273d2942478b167) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Remove the unused paused/resumed run events and states
  - Remove `run_paused` and `run_resumed` event types
  - Remove `paused` status from `WorkflowRunStatus`
  - Remove `PauseWorkflowRunParams` and `ResumeWorkflowRunParams` types
  - Remove `pauseWorkflowRun` and `resumeWorkflowRun` functions from world-vercel

- [#744](https://github.com/vercel/workflow/pull/744) [`e7de61f`](https://github.com/vercel/workflow/commit/e7de61f8b88ad7c710208ef599872085fb7b6d32) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add `--localUi` CLI flag to use local web UI instead of Vercel dashboard

- [#722](https://github.com/vercel/workflow/pull/722) [`05ecfbc`](https://github.com/vercel/workflow/commit/05ecfbcc11508defc7ccd0a8b67839eaef631e71) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Ensure npm pre-release version update checks work for post-GA release pre-releases

- Updated dependencies [[`dd3db13`](https://github.com/vercel/workflow/commit/dd3db13d5498622284ed97c1a273d2942478b167)]:
  - @workflow/world@4.0.1-beta.12
  - @workflow/world-local@4.0.1-beta.25
  - @workflow/world-vercel@4.0.1-beta.26
  - @workflow/web@4.0.1-beta.25
  - @workflow/core@4.0.1-beta.36
  - @workflow/errors@4.0.1-beta.13
  - @workflow/builders@4.0.1-beta.36

## 4.0.1-beta.42

### Patch Changes

- Updated dependencies [[`4d6f797`](https://github.com/vercel/workflow/commit/4d6f797274331b2efa69576dda7361ef7f704edf), [`0da8e54`](https://github.com/vercel/workflow/commit/0da8e543742ad160dedc28f998cfe16fe1e3fd84), [`8bc4e5f`](https://github.com/vercel/workflow/commit/8bc4e5fe3ccd67ccdd39737d3d30ad4268215a27), [`505063c`](https://github.com/vercel/workflow/commit/505063cbb9ef04af8531c2cd3cd3840b5d272f82), [`4d6f797`](https://github.com/vercel/workflow/commit/4d6f797274331b2efa69576dda7361ef7f704edf)]:
  - @workflow/builders@4.0.1-beta.35
  - @workflow/web@4.0.1-beta.24
  - @workflow/core@4.0.1-beta.35

## 4.0.1-beta.41

### Patch Changes

- [#701](https://github.com/vercel/workflow/pull/701) [`1a305bf`](https://github.com/vercel/workflow/commit/1a305bf91876b714699b91c6ac73bcbafde670d0) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Display a notice when using an outdated version of the workflow package

- Updated dependencies [[`d552374`](https://github.com/vercel/workflow/commit/d552374b13945c76cbffccfcfdef38f4e3b5a97c)]:
  - @workflow/builders@4.0.1-beta.34

## 4.0.1-beta.40

### Patch Changes

- Updated dependencies [[`9b1640d`](https://github.com/vercel/workflow/commit/9b1640d76e7e759446058d65272011071bb250d2), [`9b1640d`](https://github.com/vercel/workflow/commit/9b1640d76e7e759446058d65272011071bb250d2), [`9b1640d`](https://github.com/vercel/workflow/commit/9b1640d76e7e759446058d65272011071bb250d2), [`307f4b0`](https://github.com/vercel/workflow/commit/307f4b0e41277f6b32afbfa361d8c6ca1b3d7f6c), [`7ff68d1`](https://github.com/vercel/workflow/commit/7ff68d1753c43b14d161d249f6745de6beddd99b)]:
  - @workflow/core@4.0.1-beta.34
  - @workflow/web@4.0.1-beta.23
  - @workflow/utils@4.0.1-beta.10
  - @workflow/builders@4.0.1-beta.33
  - @workflow/errors@4.0.1-beta.13
  - @workflow/world-local@4.0.1-beta.24
  - @workflow/world-vercel@4.0.1-beta.25

## 4.0.1-beta.39

### Patch Changes

- Updated dependencies [[`2dbe494`](https://github.com/vercel/workflow/commit/2dbe49495dd4fae22edc53e190952c8f15289b8b)]:
  - @workflow/world-local@4.0.1-beta.23
  - @workflow/core@4.0.1-beta.33
  - @workflow/builders@4.0.1-beta.32
  - @workflow/web@4.0.1-beta.22

## 4.0.1-beta.38

### Patch Changes

- [#684](https://github.com/vercel/workflow/pull/684) [`80955e7`](https://github.com/vercel/workflow/commit/80955e7212b38237710249f7ac3c17fb55cae49b) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Allow opening UI without a valid local config detected, UI will show warning and watch folder

- Updated dependencies [[`f989613`](https://github.com/vercel/workflow/commit/f989613d7020f987fba2c74f2e49c8d47ff74a29)]:
  - @workflow/web@4.0.1-beta.22

## 4.0.1-beta.37

### Patch Changes

- Updated dependencies [[`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6)]:
  - @workflow/world-local@4.0.1-beta.22
  - @workflow/builders@4.0.1-beta.31
  - @workflow/utils@4.0.1-beta.9
  - @workflow/world@4.0.1-beta.11
  - @workflow/core@4.0.1-beta.32
  - @workflow/web@4.0.1-beta.21
  - @workflow/errors@4.0.1-beta.12
  - @workflow/world-vercel@4.0.1-beta.24

## 4.0.1-beta.36

### Patch Changes

- [#682](https://github.com/vercel/workflow/pull/682) [`0cf0ac3`](https://github.com/vercel/workflow/commit/0cf0ac32114bcdfa49319d27c2ce98da516690f1) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Extract helper to find local world dataDir across CLI/web projects

- [#669](https://github.com/vercel/workflow/pull/669) [`c059cf6`](https://github.com/vercel/workflow/commit/c059cf6fcd0988b380f66dfa0f2bb85a19cc4063) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add -i / --interactive flag for enabling pagination bindings, new default being off

- Updated dependencies [[`d9f6a49`](https://github.com/vercel/workflow/commit/d9f6a4939760be94dfc9eaf77dcaa48c602c18ef), [`0cf0ac3`](https://github.com/vercel/workflow/commit/0cf0ac32114bcdfa49319d27c2ce98da516690f1), [`4bc98ff`](https://github.com/vercel/workflow/commit/4bc98ff4a15a090e2233c18b75e0a1b5dd2e9ff1), [`ea3afce`](https://github.com/vercel/workflow/commit/ea3afce222ff9c2f90d99414fae275ef5f54b431), [`25b02b0`](https://github.com/vercel/workflow/commit/25b02b0bfdefa499e13fb974b1832fbe47dbde86), [`c3464bf`](https://github.com/vercel/workflow/commit/c3464bfd978a073f6d8fca95208bd053aa5c78dd)]:
  - @workflow/world-local@4.0.1-beta.21
  - @workflow/utils@4.0.1-beta.8
  - @workflow/web@4.0.1-beta.20
  - @workflow/builders@4.0.1-beta.30
  - @workflow/core@4.0.1-beta.31
  - @workflow/errors@4.0.1-beta.11
  - @workflow/world-vercel@4.0.1-beta.23

## 4.0.1-beta.35

### Patch Changes

- Updated dependencies [[`ef22f82`](https://github.com/vercel/workflow/commit/ef22f82c9ead53744bac23fa12ed6bfbb1aba0bb), [`f2d5997`](https://github.com/vercel/workflow/commit/f2d5997b800d6c474bb93d4ddd82cf52489752da)]:
  - @workflow/web@4.0.1-beta.19
  - @workflow/world-local@4.0.1-beta.20
  - @workflow/core@4.0.1-beta.30
  - @workflow/builders@4.0.1-beta.29

## 4.0.1-beta.34

### Patch Changes

- Updated dependencies [[`f396833`](https://github.com/vercel/workflow/commit/f39683370dc187273bd8aa5108e11e49dffe027a), [`eaf9aa6`](https://github.com/vercel/workflow/commit/eaf9aa65f354bf1e22e8e148c0fd1936f0ec9358), [`75a5060`](https://github.com/vercel/workflow/commit/75a506047304f6dd1ac07d9150e8a9563f69283c), [`6cd1a47`](https://github.com/vercel/workflow/commit/6cd1a47b3146770f5cb9d4c384971331aab6b28a)]:
  - @workflow/web@4.0.1-beta.18
  - @workflow/core@4.0.1-beta.29
  - @workflow/world-vercel@4.0.1-beta.22
  - @workflow/builders@4.0.1-beta.28

## 4.0.1-beta.33

### Patch Changes

- [#638](https://github.com/vercel/workflow/pull/638) [`4bdd3e5`](https://github.com/vercel/workflow/commit/4bdd3e5086a51a46898cca774533019d3ace77b3) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Move auth error messages into @workflow/errors package

- Updated dependencies [[`ea2a67e`](https://github.com/vercel/workflow/commit/ea2a67e19c5d224b4b4fd1c1a417810562df0807), [`ce7d428`](https://github.com/vercel/workflow/commit/ce7d428a07cd415d2ea64c779b84ecdc796927a0), [`712f6f8`](https://github.com/vercel/workflow/commit/712f6f86b1804c82d4cab3bba0db49584451d005), [`ab55ba2`](https://github.com/vercel/workflow/commit/ab55ba2d61b41e2b2cd9e213069c93be988c9b1e), [`712f6f8`](https://github.com/vercel/workflow/commit/712f6f86b1804c82d4cab3bba0db49584451d005), [`4bdd3e5`](https://github.com/vercel/workflow/commit/4bdd3e5086a51a46898cca774533019d3ace77b3)]:
  - @workflow/core@4.0.1-beta.28
  - @workflow/world-local@4.0.1-beta.19
  - @workflow/world-vercel@4.0.1-beta.21
  - @workflow/errors@4.0.1-beta.10
  - @workflow/builders@4.0.1-beta.27
  - @workflow/web@4.0.1-beta.17

## 4.0.1-beta.32

### Patch Changes

- [#627](https://github.com/vercel/workflow/pull/627) [`deaf019`](https://github.com/vercel/workflow/commit/deaf0193e91ea7a24d2423a813b64f51faa681e3) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - [world-vercel] Allow skipping vercel backend proxy for e2e tests where CLI runs in runtime env

- Updated dependencies [[`05ea678`](https://github.com/vercel/workflow/commit/05ea6789e5773d5b4ee16dce4a800e613261f452), [`deaf019`](https://github.com/vercel/workflow/commit/deaf0193e91ea7a24d2423a813b64f51faa681e3), [`b56aae3`](https://github.com/vercel/workflow/commit/b56aae3fe9b5568d7bdda592ed025b3499149240), [`4d7a393`](https://github.com/vercel/workflow/commit/4d7a393906846be751e798c943594bec3c9b0ff3)]:
  - @workflow/web@4.0.1-beta.17
  - @workflow/world-vercel@4.0.1-beta.20
  - @workflow/core@4.0.1-beta.27
  - @workflow/errors@4.0.1-beta.9
  - @workflow/world-local@4.0.1-beta.18
  - @workflow/builders@4.0.1-beta.26

## 4.0.1-beta.31

### Patch Changes

- Updated dependencies [[`6265534`](https://github.com/vercel/workflow/commit/6265534d6be2cba54265ef23b94a0810d9e25c9c)]:
  - @workflow/web@4.0.1-beta.16

## 4.0.1-beta.30

### Patch Changes

- Updated dependencies [[`c9b8d84`](https://github.com/vercel/workflow/commit/c9b8d843fd0a88de268d603a14ebe2e7c726169a), [`696e7e3`](https://github.com/vercel/workflow/commit/696e7e31e88eae5d86e9d4b9f0344f0777ae9673)]:
  - @workflow/world-local@4.0.1-beta.17
  - @workflow/core@4.0.1-beta.26
  - @workflow/web@4.0.1-beta.15
  - @workflow/errors@4.0.1-beta.8
  - @workflow/builders@4.0.1-beta.25
  - @workflow/world-vercel@4.0.1-beta.19

## 4.0.1-beta.29

### Patch Changes

- [#575](https://github.com/vercel/workflow/pull/575) [`161c54c`](https://github.com/vercel/workflow/commit/161c54ca13e0c36220640e656b7abe4ff282dbb0) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add Web and CLI UI for listing and viewing streams

- Updated dependencies [[`19c271c`](https://github.com/vercel/workflow/commit/19c271c0725f263ebbcbd87e68240547c1acbe2f), [`161c54c`](https://github.com/vercel/workflow/commit/161c54ca13e0c36220640e656b7abe4ff282dbb0), [`d42a968`](https://github.com/vercel/workflow/commit/d42a9681a1c7139ac5ed2973b1738d8a9000a1b6), [`33c254c`](https://github.com/vercel/workflow/commit/33c254c82c1c452300d6bff531c33329aa01d4ec), [`c82b467`](https://github.com/vercel/workflow/commit/c82b46720cf6284f3c7e3ded107e1d8321f6e705), [`0bbd26f`](https://github.com/vercel/workflow/commit/0bbd26f8c85a04dea3dc87a11c52e9ac63a18e84), [`c35b445`](https://github.com/vercel/workflow/commit/c35b4458753cc116b90d61f470f7ab1d964e8a1e), [`d3fd81d`](https://github.com/vercel/workflow/commit/d3fd81dffd87abbd1a3d8a8e91e9781959eefd40), [`058757c`](https://github.com/vercel/workflow/commit/058757c476579a7b1bb6a8ba9a3d15f57b30c898)]:
  - @workflow/builders@4.0.1-beta.24
  - @workflow/core@4.0.1-beta.25
  - @workflow/web@4.0.1-beta.15
  - @workflow/world-local@4.0.1-beta.16
  - @workflow/world-vercel@4.0.1-beta.18
  - @workflow/world@4.0.1-beta.10
  - @workflow/errors@4.0.1-beta.7

## 4.0.1-beta.28

### Patch Changes

- 57a2c32: Add expiredAt attribute to Run
- Updated dependencies [48b3a12]
- Updated dependencies [57a2c32]
- Updated dependencies [14daedd]
- Updated dependencies [fc774e5]
- Updated dependencies [4aecb99]
- Updated dependencies [24e6271]
- Updated dependencies [21cff15]
- Updated dependencies [fa37d26]
- Updated dependencies [f46c51e]
- Updated dependencies [8172455]
- Updated dependencies [af5b005]
- Updated dependencies [43f2dec]
  - @workflow/world-local@4.0.1-beta.15
  - @workflow/world@4.0.1-beta.9
  - @workflow/web@4.0.1-beta.14
  - @workflow/builders@4.0.1-beta.23
  - @workflow/swc-plugin@4.0.1-beta.12
  - @workflow/core@4.0.1-beta.24
  - @workflow/errors@4.0.1-beta.7
  - @workflow/world-vercel@4.0.1-beta.17

## 4.0.1-beta.27

### Patch Changes

- Updated dependencies [ca27c0f]
  - @workflow/web@4.0.1-beta.13

## 4.0.1-beta.26

### Patch Changes

- Updated dependencies [c8fa70a]
  - @workflow/world-vercel@4.0.1-beta.16
  - @workflow/core@4.0.1-beta.23
  - @workflow/builders@4.0.1-beta.22
  - @workflow/web@4.0.1-beta.12

## 4.0.1-beta.25

### Patch Changes

- Updated dependencies [ac7997b]
- Updated dependencies [02c41cc]
  - @workflow/swc-plugin@4.0.1-beta.11
  - @workflow/builders@4.0.1-beta.21
  - @workflow/core@4.0.1-beta.22
  - @workflow/web@4.0.1-beta.12

## 4.0.1-beta.24

### Patch Changes

- Updated dependencies [2f0840b]
- Updated dependencies [555d7a6]
- Updated dependencies [e9494d5]
  - @workflow/core@4.0.1-beta.21
  - @workflow/swc-plugin@4.0.1-beta.10
  - @workflow/world-vercel@4.0.1-beta.15
  - @workflow/builders@4.0.1-beta.20
  - @workflow/web@4.0.1-beta.12

## 4.0.1-beta.23

### Patch Changes

- 8d4562e: Rename leftover references to "embedded world" to be "local world"
- Updated dependencies [d53bf90]
- Updated dependencies [0f1645b]
- Updated dependencies [3c19e90]
- Updated dependencies [1ac5592]
- Updated dependencies [6e8e828]
- Updated dependencies [5b91861]
- Updated dependencies [10c5b91]
- Updated dependencies [bdde1bd]
- Updated dependencies [109fe59]
- Updated dependencies [0cacb99]
- Updated dependencies [2faddf3]
- Updated dependencies [10c5b91]
- Updated dependencies [8d4562e]
  - @workflow/builders@4.0.1-beta.19
  - @workflow/core@4.0.1-beta.20
  - @workflow/world-local@4.0.1-beta.14
  - @workflow/swc-plugin@4.0.1-beta.9
  - @workflow/world@4.0.1-beta.8
  - @workflow/web@4.0.1-beta.12
  - @workflow/errors@4.0.1-beta.7
  - @workflow/world-vercel@4.0.1-beta.14

## 4.0.1-beta.22

### Patch Changes

- Updated dependencies [07800c2]
- Updated dependencies [fb9fd0f]
- Updated dependencies [b042ba7]
- Updated dependencies [8b470f0]
- Updated dependencies [40057db]
  - @workflow/core@4.0.1-beta.19
  - @workflow/swc-plugin@4.0.1-beta.8
  - @workflow/world@4.0.1-beta.7
  - @workflow/builders@4.0.1-beta.18
  - @workflow/world-local@4.0.1-beta.13
  - @workflow/web@4.0.1-beta.11
  - @workflow/errors@4.0.1-beta.6
  - @workflow/world-vercel@4.0.1-beta.13

## 4.0.1-beta.21

### Patch Changes

- Updated dependencies [6889dac]
  - @workflow/world-vercel@4.0.1-beta.12
  - @workflow/core@4.0.1-beta.18
  - @workflow/builders@4.0.1-beta.17
  - @workflow/web@4.0.1-beta.11

## 4.0.1-beta.20

### Patch Changes

- Updated dependencies [2c438c3]
- Updated dependencies [edb69c3]
  - @workflow/world-vercel@4.0.1-beta.11
  - @workflow/world-local@4.0.1-beta.12
  - @workflow/core@4.0.1-beta.17
  - @workflow/errors@4.0.1-beta.6
  - @workflow/builders@4.0.1-beta.16
  - @workflow/web@4.0.1-beta.11

## 4.0.1-beta.19

### Patch Changes

- Updated dependencies [3436629]
- Updated dependencies [9961140]
- Updated dependencies [73b6c68]
  - @workflow/core@4.0.1-beta.16
  - @workflow/world-local@4.0.1-beta.11
  - @workflow/builders@4.0.1-beta.15
  - @workflow/web@4.0.1-beta.11

## 4.0.1-beta.18

### Patch Changes

- Updated dependencies [e5c5236]
  - @workflow/swc-plugin@4.0.1-beta.7
  - @workflow/builders@4.0.1-beta.14

## 4.0.1-beta.17

### Patch Changes

- Updated dependencies [3d99d6d]
  - @workflow/world-vercel@4.0.1-beta.10
  - @workflow/world-local@5.0.0-beta.10
  - @workflow/core@4.0.1-beta.15
  - @workflow/builders@4.0.1-beta.13
  - @workflow/web@4.0.1-beta.11

## 4.0.1-beta.16

### Patch Changes

- Updated dependencies [6e41c90]
  - @workflow/core@4.0.1-beta.14
  - @workflow/builders@4.0.1-beta.12
  - @workflow/web@4.0.1-beta.11

## 4.0.1-beta.15

### Patch Changes

- Updated dependencies [2fde24e]
- Updated dependencies [4b70739]
  - @workflow/core@4.0.1-beta.13
  - @workflow/world-vercel@4.0.1-beta.9
  - @workflow/world-local@5.0.0-beta.9
  - @workflow/world@4.0.1-beta.6
  - @workflow/builders@4.0.1-beta.11
  - @workflow/web@4.0.1-beta.11
  - @workflow/errors@4.0.1-beta.5

## 4.0.1-beta.14

### Patch Changes

- b97b6bf: Lock all dependencies in our packages
- Updated dependencies [aa015af]
- Updated dependencies [00b0bb9]
- Updated dependencies [5eb588a]
- Updated dependencies [00b0bb9]
- Updated dependencies [0b848cd]
- Updated dependencies [85ce8e0]
- Updated dependencies [8e96134]
- Updated dependencies [b97b6bf]
- Updated dependencies [45b7b41]
- Updated dependencies [00b0bb9]
- Updated dependencies [f8e5d10]
- Updated dependencies [6be03f3]
- Updated dependencies [8002e0f]
- Updated dependencies [f07b2da]
- Updated dependencies [00b0bb9]
- Updated dependencies [00b0bb9]
- Updated dependencies [79480f2]
- Updated dependencies [aecdcdf]
  - @workflow/world-local@5.0.0-beta.8
  - @workflow/swc-plugin@4.0.1-beta.6
  - @workflow/core@4.0.1-beta.12
  - @workflow/builders@4.0.1-beta.10
  - @workflow/world-vercel@4.0.1-beta.8
  - @workflow/errors@4.0.1-beta.5
  - @workflow/web@4.0.1-beta.11
  - @workflow/world@4.0.1-beta.5

## 4.0.1-beta.13

### Patch Changes

- 11469d8: Update default fallback path for connecting to local world
- 00efdfb: Fix --noBrowser option help documentation
- Updated dependencies [8208b53]
- Updated dependencies [2b880f9]
- Updated dependencies [11469d8]
- Updated dependencies [4f9ae4e]
- Updated dependencies [2dca0d4]
- Updated dependencies [aac1b6c]
- Updated dependencies [6373ab5]
- Updated dependencies [68363b2]
- Updated dependencies [00efdfb]
  - @workflow/builders@4.0.1-beta.9
  - @workflow/core@4.0.1-beta.11
  - @workflow/world-local@4.0.1-beta.7
  - @workflow/web@4.0.1-beta.10
  - @workflow/swc-plugin@4.0.1-beta.5
  - @workflow/world-vercel@4.0.1-beta.7

## 4.0.1-beta.12

### Patch Changes

- Updated dependencies [7013f29]
- Updated dependencies [a28bc37]
- Updated dependencies [e0c6618]
- Updated dependencies [809e0fe]
- Updated dependencies [adf0cfe]
- Updated dependencies [5c0268b]
- Updated dependencies [0b3e89e]
- Updated dependencies [7a47eb8]
  - @workflow/core@4.0.1-beta.10
  - @workflow/swc-plugin@4.0.1-beta.4
  - @workflow/world-local@4.0.1-beta.6
  - @workflow/web@4.0.1-beta.9
  - @workflow/errors@4.0.1-beta.4
  - @workflow/builders@4.0.1-beta.8
  - @workflow/world-vercel@4.0.1-beta.6

## 4.0.1-beta.11

### Patch Changes

- Updated dependencies [9f56434]
  - @workflow/core@4.0.1-beta.9
  - @workflow/web@4.0.1-beta.8
  - @workflow/builders@4.0.1-beta.7

## 4.0.1-beta.10

### Patch Changes

- 03faac1: Fix CLI `--web` flag on Windows
- d71da4a: Update "alpha" text in CLI help to "beta"
- Updated dependencies [c2fa9df]
  - @workflow/builders@4.0.1-beta.6
  - @workflow/web@4.0.1-beta.8

## 4.0.1-beta.9

### Patch Changes

- 4a821fc: Fix Windows path handling by normalizing backslashes to forward slashes in workflow IDs
- Updated dependencies [4a821fc]
- Updated dependencies [4a821fc]
  - @workflow/swc-plugin@4.0.1-beta.3
  - @workflow/builders@4.0.1-beta.5
  - @workflow/core@4.0.1-beta.8
  - @workflow/web@4.0.1-beta.8

## 4.0.1-beta.8

### Patch Changes

- a09a3ea: Remove unused builder code from CLI
- 652485a: Create @workflow/builders package with shared builder infrastructure
- 4585222: Deduplicate package.json and .vc-config.json generation
- 10bfd4a: Extract path resolution and directory creation helpers
- 5dfa4eb: Extract queue trigger configuration constants
- 05714f7: Add sveltekit workflow integration
- bf54a7b: Standardize method naming conventions
- Updated dependencies [80d68b7]
- Updated dependencies [744d82f]
- Updated dependencies [ebee7f5]
- Updated dependencies [652485a]
- Updated dependencies [4585222]
- Updated dependencies [10bfd4a]
- Updated dependencies [5dfa4eb]
- Updated dependencies [05714f7]
- Updated dependencies [f8c779e]
- Updated dependencies [bf54a7b]
- Updated dependencies [7db9e94]
  - @workflow/builders@4.0.1-beta.4
  - @workflow/world-local@4.0.1-beta.5
  - @workflow/core@4.0.1-beta.7
  - @workflow/web@4.0.1-beta.8

## 4.0.1-beta.7

### Patch Changes

- f973954: Update license to Apache 2.0
- a3326a2: Add `workflow inspect sleep` command to list active sleep/wait events
- Updated dependencies [10309c3]
- Updated dependencies [2ae7426]
- Updated dependencies [10309c3]
- Updated dependencies [f973954]
- Updated dependencies [2ae7426]
  - @workflow/core@4.0.1-beta.6
  - @workflow/web@4.0.1-beta.7
  - @workflow/world-local@4.0.1-beta.4
  - @workflow/swc-plugin@4.0.1-beta.2
  - @workflow/world-vercel@4.0.1-beta.5
  - @workflow/errors@4.0.1-beta.3
  - @workflow/world@4.0.1-beta.4

## 4.0.1-beta.6

### Patch Changes

- Updated dependencies [20d51f0]
- Updated dependencies [796fafd]
- Updated dependencies [8f63385]
- Updated dependencies [796fafd]
- Updated dependencies [20d51f0]
- Updated dependencies [20d51f0]
- Updated dependencies [70be894]
- Updated dependencies [20d51f0]
- Updated dependencies [55e2d0b]
  - @workflow/world-vercel@4.0.1-beta.4
  - @workflow/core@4.0.1-beta.5
  - @workflow/web@4.0.1-beta.6
  - @workflow/errors@4.0.1-beta.2
  - @workflow/world-local@4.0.1-beta.3
  - @workflow/world@4.0.1-beta.3

## 4.0.1-beta.5

### Patch Changes

- 0f845af: Alias workflow web to workflow inspect runs --web, hide trace viewer search for small runs
- Updated dependencies [6504e42]
- Updated dependencies [0f845af]
- Updated dependencies [e367046]
- Updated dependencies [ffb7af3]
  - @workflow/core@4.0.1-beta.4
  - @workflow/web@4.0.1-beta.5
  - @workflow/world-vercel@4.0.1-beta.3

## 4.0.1-beta.4

### Patch Changes

- 66332f2: Rename vercel-static builder to standalone
- dbf2207: Fix --backend flag not finding world when using local world package name explicitly
- Updated dependencies [dbf2207]
- Updated dependencies [eadf588]
  - @workflow/web@4.0.1-beta.4

## 4.0.1-beta.3

### Patch Changes

- dfdb280: Generate the webhook route in the static builder mode
- d3a4ed3: Move `@types/watchpack` to be a devDependency
- Updated dependencies [d3a4ed3]
- Updated dependencies [d3a4ed3]
- Updated dependencies [66225bf]
- Updated dependencies [7868434]
- Updated dependencies [731adff]
- Updated dependencies [57419e5]
- Updated dependencies [22917ab]
- Updated dependencies [66225bf]
- Updated dependencies [9ba86ce]
  - @workflow/world@4.0.1-beta.2
  - @workflow/world-local@4.0.1-beta.2
  - @workflow/world-vercel@4.0.1-beta.2
  - @workflow/web@4.0.1-beta.3
  - @workflow/core@4.0.1-beta.3

## 4.0.1-beta.2

### Patch Changes

- f5f171f: Fine tune CLI output table width for smaller displays
- Updated dependencies [f5f171f]
- Updated dependencies [854feb4]
- Updated dependencies [f1c6bc5]
  - @workflow/web@4.0.1-beta.2
  - @workflow/core@4.0.1-beta.2

## 4.0.1-beta.1

### Patch Changes

- 57ebfcb: CLI: Allow using package names instead of alias names for --backend flag
- 1408293: Add "description" field to `package.json` file
- 8196cd9: Allow specifying vercel world package name as an alias for "vercel"
- e46294f: Add "license" and "repository" fields to `package.json` file
- Updated dependencies [57ebfcb]
- Updated dependencies [1408293]
- Updated dependencies [8422a32]
- Updated dependencies [e46294f]
  - @workflow/core@4.0.1-beta.1
  - @workflow/swc-plugin@4.0.1-beta.1
  - @workflow/world-vercel@4.0.1-beta.1
  - @workflow/world-local@4.0.1-beta.1
  - @workflow/errors@4.0.1-beta.1
  - @workflow/world@4.0.1-beta.1
  - @workflow/web@4.0.1-beta.1

## 4.0.1-beta.0

### Patch Changes

- fcf63d0: Initial publish
- Updated dependencies [fcf63d0]
  - @workflow/swc-plugin@4.0.1-beta.0
  - @workflow/world-vercel@4.0.1-beta.0
  - @workflow/world-local@4.0.1-beta.0
  - @workflow/errors@4.0.1-beta.0
  - @workflow/world@4.0.1-beta.0
  - @workflow/core@4.0.1-beta.0
  - @workflow/web@4.0.1-beta.0
