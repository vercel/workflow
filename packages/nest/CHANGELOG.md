# @workflow/nest

## 4.0.21

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.1.10

## 4.0.20

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.1.9

## 4.0.19

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.1.8

## 4.0.18

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.1.7

## 4.0.17

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.1.6

## 4.0.16

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.1.5

## 4.0.15

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.1.4

## 4.0.14

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.1.3

## 4.0.13

### Patch Changes

- Updated dependencies [[`f1f7e1d`](https://github.com/vercel/workflow/commit/f1f7e1dc25c7346f2ac65e3e8a0a15a6e4fd7ccd), [`2213c91`](https://github.com/vercel/workflow/commit/2213c91731f6d47373f4ba4c516c39ec2cc0fa94)]:
  - @workflow/builders@4.1.2

## 4.0.12

### Patch Changes

- [#2546](https://github.com/vercel/workflow/pull/2546) [`ba62f57`](https://github.com/vercel/workflow/commit/ba62f575e249845d762984f75fcb1a7405a3c8fc) Thanks [@ijjk](https://github.com/ijjk)! - Optimize eager workflow discovery and improve default eager build compatibility. Also fixes NestJS builds pulling SDK build-tooling into the runtime steps bundle, which crashed step handlers at runtime.

- Updated dependencies [[`c4bc5a1`](https://github.com/vercel/workflow/commit/c4bc5a1590d4df06a9ed76e93512e1b9082921d1), [`ba62f57`](https://github.com/vercel/workflow/commit/ba62f575e249845d762984f75fcb1a7405a3c8fc), [`504cf88`](https://github.com/vercel/workflow/commit/504cf88465cfe6502c4e8d87b3bcfac2534e22c8), [`578f7e1`](https://github.com/vercel/workflow/commit/578f7e1f1b03d2a7eb39591aa457931b960755cb), [`8bbf331`](https://github.com/vercel/workflow/commit/8bbf3312adf8eb9b910aa6161e578ac83ef293f5), [`a4dd59b`](https://github.com/vercel/workflow/commit/a4dd59be8c023dad2c173ad4cf1ed565ced34c56), [`4c49cc8`](https://github.com/vercel/workflow/commit/4c49cc88957bedcc59f16f2bb4b905a0056d5eff), [`c5d14c8`](https://github.com/vercel/workflow/commit/c5d14c8a89b12cabd6ce9e008afb41780bff2adc), [`b357137`](https://github.com/vercel/workflow/commit/b3571378b8ce9964843d76ce1c5b6e5e2c4cf5da), [`8d1f299`](https://github.com/vercel/workflow/commit/8d1f2993cb8e266e6b688d461160d847011b8393)]:
  - @workflow/builders@4.1.1
  - @workflow/swc-plugin@4.1.2

## 0.0.10

### Patch Changes

- Updated dependencies [[`15507bd`](https://github.com/vercel/workflow/commit/15507bdccf8bb62b9d3fd5646428ada33c29caec), [`9c667e0`](https://github.com/vercel/workflow/commit/9c667e05c2aad0158698099ac84a846e10ed5700)]:
  - @workflow/builders@4.1.0

## 0.0.9

### Patch Changes

- [#2080](https://github.com/vercel/workflow/pull/2080) [`4df5cff`](https://github.com/vercel/workflow/commit/4df5cff6014b06a951aa84bc8adc9beb1cb86f07) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Use AST-based import rewriting for NestJS CommonJS workflow bundles.

- [#1799](https://github.com/vercel/workflow/pull/1799) [`eca3b51`](https://github.com/vercel/workflow/commit/eca3b51a034b51e0c0ca89b949ee28d1f07a2cbb) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Use inline sourcemaps for all workspace packages; published packages no longer ship external `.js.map` files.

- Updated dependencies [[`b93a071`](https://github.com/vercel/workflow/commit/b93a0717960dcdc9b8dc37f83cbebad8ec38f3b9), [`eca3b51`](https://github.com/vercel/workflow/commit/eca3b51a034b51e0c0ca89b949ee28d1f07a2cbb)]:
  - @workflow/builders@4.0.10

## 0.0.8

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.9

## 0.0.7

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.8

## 0.0.6

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.7

## 0.0.5

### Patch Changes

- [#1986](https://github.com/vercel/workflow/pull/1986) [`16f2c23`](https://github.com/vercel/workflow/commit/16f2c236d3b64643f07f5e85906c0112b7c132cc) Thanks [@pranaygp](https://github.com/pranaygp)! - Fix local workflow port detection, make generated health endpoints respond to HEAD requests, materialize manual webhook response bodies before returning them, wait for step return stream serialization before completing the step, bound Vercel stream and health-check operations so stuck writes or queue sends retry or time out instead of hanging, and stabilize remote Vercel e2e checks around CLI inspection, sleep timing, and hook registration/disposal.

- Updated dependencies [[`478a9c7`](https://github.com/vercel/workflow/commit/478a9c76183b925e44439b7a5d1f849174804b64), [`066c157`](https://github.com/vercel/workflow/commit/066c157a2b5053196995e8636af7e0357ea6e58a), [`a9cc1d5`](https://github.com/vercel/workflow/commit/a9cc1d5ac1bdbb9055373e38b82dfc4046fc2bc9), [`16f2c23`](https://github.com/vercel/workflow/commit/16f2c236d3b64643f07f5e85906c0112b7c132cc), [`6aabd6f`](https://github.com/vercel/workflow/commit/6aabd6fd2ef407c3a57835b2c51ceb881a77935f), [`6aabd6f`](https://github.com/vercel/workflow/commit/6aabd6fd2ef407c3a57835b2c51ceb881a77935f), [`14326ad`](https://github.com/vercel/workflow/commit/14326adcf9b8f5dce753a739555e162cd03dc19f)]:
  - @workflow/builders@4.0.6
  - @workflow/swc-plugin@4.1.1

## 0.0.4

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.5

## 0.0.3

### Patch Changes

- Updated dependencies [[`6f48e9e`](https://github.com/vercel/workflow/commit/6f48e9e778d73d42ade3762ba3fff0e46877a812)]:
  - @workflow/builders@4.0.4

## 0.0.2

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.3

## 0.0.1

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.2

## 0.0.0

### Patch Changes

- [#1640](https://github.com/vercel/workflow/pull/1640) [`8890b33`](https://github.com/vercel/workflow/commit/8890b33b9b6497824309ced298a7b1acab73142c) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Stable release

- Updated dependencies [[`8890b33`](https://github.com/vercel/workflow/commit/8890b33b9b6497824309ced298a7b1acab73142c), [`1ef83dc`](https://github.com/vercel/workflow/commit/1ef83dcc086f44a05b1801ed299de8e48cea9fa3)]:
  - @workflow/builders@4.0.1
  - @workflow/swc-plugin@4.1.0

## 0.0.0-beta.26

### Patch Changes

- Updated dependencies [[`d1330cf`](https://github.com/vercel/workflow/commit/d1330cfebca1b2f552bd80c06e37bff4fba1b79e), [`5d22e61`](https://github.com/vercel/workflow/commit/5d22e61446d5146887f8c268d305ea42e3f67b09), [`7c996a7`](https://github.com/vercel/workflow/commit/7c996a76c59cb88fa58d15942218b308d1cd100f), [`443a9e6`](https://github.com/vercel/workflow/commit/443a9e62f938b91cd818106155d384329cf5c82c)]:
  - @workflow/builders@4.0.1-beta.68
  - @workflow/swc-plugin@4.1.0-beta.22

## 0.0.0-beta.25

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.67

## 0.0.0-beta.24

### Patch Changes

- Updated dependencies [[`6dc1b78`](https://github.com/vercel/workflow/commit/6dc1b785822af5c1dc3b4a2a9b1dcb7f626cf5ff)]:
  - @workflow/builders@4.0.1-beta.66

## 0.0.0-beta.23

### Patch Changes

- Updated dependencies [[`a3b7c48`](https://github.com/vercel/workflow/commit/a3b7c480e058e9070d2ecb8b84b38bbf2081840a), [`d119c74`](https://github.com/vercel/workflow/commit/d119c740d095ae601598bc2a62e6269e06f70f3e)]:
  - @workflow/builders@4.0.1-beta.65

## 0.0.0-beta.22

### Patch Changes

- Updated dependencies [[`52db376`](https://github.com/vercel/workflow/commit/52db376c39ef322e8e458c0f81ccc67c9ab2b301)]:
  - @workflow/builders@4.0.1-beta.64

## 0.0.0-beta.21

### Patch Changes

- [#1501](https://github.com/vercel/workflow/pull/1501) [`1b4a3ab`](https://github.com/vercel/workflow/commit/1b4a3abbf15cfee1db9da28a7ab7dd177c3e91ee) Thanks [@pranaygp](https://github.com/pranaygp)! - Update nest, nitro, nuxt and sveltekit integration dependencies

- Updated dependencies [[`beccbc4`](https://github.com/vercel/workflow/commit/beccbc4298f434a4ffb9563c4f832f2230016f40), [`77fd9ad`](https://github.com/vercel/workflow/commit/77fd9ad3556544a0efd7d6c4d00eedfc03dc10e5), [`5010ebe`](https://github.com/vercel/workflow/commit/5010ebe7c5f8e2f4921e99cc22c7360ae0d49097), [`992d768`](https://github.com/vercel/workflow/commit/992d768f8026846bc2587892fc06e998d8c1fd8e), [`6cce021`](https://github.com/vercel/workflow/commit/6cce021503b80db49fea1d0085ecb304678cfc8a), [`977b7e9`](https://github.com/vercel/workflow/commit/977b7e97edabd9b4fb800a5f6e1037dc78ca3c61)]:
  - @workflow/builders@4.0.1-beta.63
  - @workflow/swc-plugin@4.1.0-beta.21

## 0.0.0-beta.20

### Patch Changes

- Updated dependencies [[`5d95abf`](https://github.com/vercel/workflow/commit/5d95abf9413462e82759bf68ab985e794ce05756), [`3cc2943`](https://github.com/vercel/workflow/commit/3cc29431b266832dd3d9b735da455d2b11612ea7)]:
  - @workflow/swc-plugin@4.1.0-beta.20
  - @workflow/builders@4.0.1-beta.62

## 0.0.0-beta.19

### Patch Changes

- [#1346](https://github.com/vercel/workflow/pull/1346) [`73c12f1`](https://github.com/vercel/workflow/commit/73c12f14dabb465e2074e2aebbcd231a4d91bc09) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix `ERR_UNSUPPORTED_ESM_URL_SCHEME` on Windows by converting absolute file paths to `file://` URLs before passing them to dynamic `import()`

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.61

## 0.0.0-beta.18

### Patch Changes

- Updated dependencies [[`d72c822`](https://github.com/vercel/workflow/commit/d72c82220f0c56bb26edbc918e485b8bd14c959b)]:
  - @workflow/builders@4.0.1-beta.60
  - @workflow/swc-plugin@4.1.0-beta.19

## 0.0.0-beta.17

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.59

## 0.0.0-beta.16

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.58

## 0.0.0-beta.15

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.57

## 0.0.0-beta.14

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.56

## 0.0.0-beta.13

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.55

## 0.0.0-beta.12

### Patch Changes

- Updated dependencies [[`809339b`](https://github.com/vercel/workflow/commit/809339ba1c8362529c9fc198f7921f19fe91f233), [`a9fea91`](https://github.com/vercel/workflow/commit/a9fea9132ef3797dbda7683c36cc86ff2bd82f1f)]:
  - @workflow/builders@4.0.1-beta.54

## 0.0.0-beta.11

### Patch Changes

- [#1217](https://github.com/vercel/workflow/pull/1217) [`e55c636`](https://github.com/vercel/workflow/commit/e55c63678b15b6687cc77efca705ee9fb40fabc3) Thanks [@pranaygp](https://github.com/pranaygp)! - Upgrade dependencies across all packages

- Updated dependencies [[`e55c636`](https://github.com/vercel/workflow/commit/e55c63678b15b6687cc77efca705ee9fb40fabc3)]:
  - @workflow/builders@4.0.1-beta.53

## 0.0.0-beta.10

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.52

## 0.0.0-beta.9

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.51

## 0.0.0-beta.8

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.50

## 0.0.0-beta.7

### Patch Changes

- [#982](https://github.com/vercel/workflow/pull/982) [`bcbdd02`](https://github.com/vercel/workflow/commit/bcbdd024efc187578d66a4c3e34ab89ab0249db7) Thanks [@boomyao](https://github.com/boomyao)! - [nest] Support CommonJS compilation for NestJS projects

- Updated dependencies [[`1c11573`](https://github.com/vercel/workflow/commit/1c1157340d88c60c7c80c0789c111050b809ab77), [`29347b7`](https://github.com/vercel/workflow/commit/29347b79eae8181d02ed1e52183983adc56425fd)]:
  - @workflow/builders@4.0.1-beta.49

## 0.0.0-beta.6

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.48

## 0.0.0-beta.5

### Patch Changes

- Updated dependencies [[`94760b4`](https://github.com/vercel/workflow/commit/94760b4640dde4ed84ff0932994ce9a47b1954ad)]:
  - @workflow/builders@4.0.1-beta.47

## 0.0.0-beta.4

### Patch Changes

- Updated dependencies [[`3d770d5`](https://github.com/vercel/workflow/commit/3d770d53855ce7c8522d4f0afbdbc123eae6c1ee), [`054e40c`](https://github.com/vercel/workflow/commit/054e40c91be615809c71d3ad29573c78c4491825), [`a5935ab`](https://github.com/vercel/workflow/commit/a5935abec7c7e57b2a89c629203d567cd7ac76a7), [`1adcc6a`](https://github.com/vercel/workflow/commit/1adcc6a618562e0b31ae53d10f9f6aa797107705)]:
  - @workflow/builders@4.0.1-beta.46
  - @workflow/swc-plugin@4.1.0-beta.18

## 0.0.0-beta.3

### Patch Changes

- Updated dependencies [[`2d1d69f`](https://github.com/vercel/workflow/commit/2d1d69f4ca7be9cf6d01aa2dfb9b031d74ba166c), [`ef23b0b`](https://github.com/vercel/workflow/commit/ef23b0be770bbb5ccca015fb2564953fe6a761d7), [`fcfaf8b`](https://github.com/vercel/workflow/commit/fcfaf8bbaa912b1767c646592e539d5f98cd1e9c)]:
  - @workflow/builders@4.0.1-beta.45
  - @workflow/swc-plugin@4.1.0-beta.17

## 0.0.0-beta.2

### Patch Changes

- [#901](https://github.com/vercel/workflow/pull/901) [`35a9f0c`](https://github.com/vercel/workflow/commit/35a9f0cb0360ffc48c8a8e7db3a299924ab48375) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix module specifier cache bug and add subpath export resolution for package IDs

- [#963](https://github.com/vercel/workflow/pull/963) [`661724c`](https://github.com/vercel/workflow/commit/661724c01e78691abad26fa99bd44f254a70f2dd) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Expose workflow manifest via HTTP when `WORKFLOW_PUBLIC_MANIFEST=1`

- Updated dependencies [[`35a9f0c`](https://github.com/vercel/workflow/commit/35a9f0cb0360ffc48c8a8e7db3a299924ab48375), [`2453b29`](https://github.com/vercel/workflow/commit/2453b29426d79497076bc910c23cac887beefc0d), [`b9c782d`](https://github.com/vercel/workflow/commit/b9c782d75f5452265764cd36d5e306060f8703c3), [`b5296a7`](https://github.com/vercel/workflow/commit/b5296a7a32b9037aa03c71d87e785fa2d5384a11), [`c1d7c8d`](https://github.com/vercel/workflow/commit/c1d7c8dbb44afb7434acb07fee500ecaa1224fb0), [`73bf7be`](https://github.com/vercel/workflow/commit/73bf7be925a8ffc0c6fce0cc75b6092243882088), [`661724c`](https://github.com/vercel/workflow/commit/661724c01e78691abad26fa99bd44f254a70f2dd), [`8114792`](https://github.com/vercel/workflow/commit/8114792600a851fbf14cf41f8340e646aef36368)]:
  - @workflow/swc-plugin@4.1.0-beta.16
  - @workflow/builders@4.0.1-beta.44

## 0.0.0-beta.1

### Patch Changes

- Updated dependencies [[`f40532a`](https://github.com/vercel/workflow/commit/f40532a8720b9b0ecb3cf4983cbfd86065503567)]:
  - @workflow/builders@4.0.1-beta.43

## 0.0.0-beta.0

### Patch Changes

- [#840](https://github.com/vercel/workflow/pull/840) [`50f50f4`](https://github.com/vercel/workflow/commit/50f50f44d79a3cf1102173ff1865cd8a01723ea3) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Create `@workflow/nest` package and add build support for NestJS

- Updated dependencies [[`50f50f4`](https://github.com/vercel/workflow/commit/50f50f44d79a3cf1102173ff1865cd8a01723ea3), [`0b5cc48`](https://github.com/vercel/workflow/commit/0b5cc4814094ecb8ec5be8eb5339c04d97b55c8b), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`13d4cee`](https://github.com/vercel/workflow/commit/13d4ceef74e1e51b6471df6a85f03b3b967c3da4), [`4ad3fcd`](https://github.com/vercel/workflow/commit/4ad3fcd0a362f3d83a6c272dec6362fe9a562c63), [`244b94a`](https://github.com/vercel/workflow/commit/244b94a0665087ece694ae881a17d6aaa0ca0a7f), [`81c5a83`](https://github.com/vercel/workflow/commit/81c5a835ae647cd94d88ccec8c3b037acdfb6598), [`b4113da`](https://github.com/vercel/workflow/commit/b4113da9541f3cebf1605d753374025f95259bf8)]:
  - @workflow/builders@4.0.1-beta.42
  - @workflow/swc-plugin@4.1.0-beta.15
