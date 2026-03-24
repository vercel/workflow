# @workflow/vitest

## 4.0.1-beta.9

### Patch Changes

- Updated dependencies [[`73a851a`](https://github.com/vercel/workflow/commit/73a851ada6a4d46ae8f022ef243ebf4ee3de2ad8), [`84599b7`](https://github.com/vercel/workflow/commit/84599b7ec5c19207082523609f1b3508a1a18bd7), [`d428d66`](https://github.com/vercel/workflow/commit/d428d66441319e612b72f9b7cf430abcf45a5ecf), [`672d919`](https://github.com/vercel/workflow/commit/672d9195a475a110a64dbaa7c5c87a24f244c11a), [`beccbc4`](https://github.com/vercel/workflow/commit/beccbc4298f434a4ffb9563c4f832f2230016f40), [`78f1b0e`](https://github.com/vercel/workflow/commit/78f1b0e19f2ac1a621020bc9fa5dec778f3b0fd9), [`da6adf7`](https://github.com/vercel/workflow/commit/da6adf7798efa38cfbe7d30209102c11cc7643c4), [`aee035f`](https://github.com/vercel/workflow/commit/aee035f94483ef3b842bb557e8c5b167dd0536c4), [`5010ebe`](https://github.com/vercel/workflow/commit/5010ebe7c5f8e2f4921e99cc22c7360ae0d49097), [`01bbe66`](https://github.com/vercel/workflow/commit/01bbe66d5a60d50d71f5b1c82b002ca7fc6f8e0b), [`6cce021`](https://github.com/vercel/workflow/commit/6cce021503b80db49fea1d0085ecb304678cfc8a), [`2b07294`](https://github.com/vercel/workflow/commit/2b072943134e8655afe8b3c2dfe535307b7a1a8b), [`977b7e9`](https://github.com/vercel/workflow/commit/977b7e97edabd9b4fb800a5f6e1037dc78ca3c61)]:
  - @workflow/core@4.2.0-beta.72
  - @workflow/world-local@4.1.0-beta.45
  - @workflow/builders@4.0.1-beta.63
  - @workflow/world@4.1.0-beta.14
  - @workflow/rollup@4.0.0-beta.29

## 4.0.1-beta.8

### Patch Changes

- [#1359](https://github.com/vercel/workflow/pull/1359) [`0f07403`](https://github.com/vercel/workflow/commit/0f074030a408078e7db0ae0e494f64125d7444e4) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Write workflow data for vitest to the same folder as other local world runs, allowing them to be visible in observability tooling. Use a suffix-based system to ensure clearing runs on test start only affects vitest-related data.

- Updated dependencies [[`02ea057`](https://github.com/vercel/workflow/commit/02ea0574422b342e6a467de073e003b73e099830), [`97e4384`](https://github.com/vercel/workflow/commit/97e43846f000f8ef0ea2f237a5c4cc696423e0f0), [`dcb0761`](https://github.com/vercel/workflow/commit/dcb07617be46b83ce74a4932bf121b20cd3de597), [`3cc2943`](https://github.com/vercel/workflow/commit/3cc29431b266832dd3d9b735da455d2b11612ea7), [`2f0772d`](https://github.com/vercel/workflow/commit/2f0772d3df4983de2f6618054379a496ade4ec5a), [`a2c0c7e`](https://github.com/vercel/workflow/commit/a2c0c7e6d9d7349bd49aac6e6ea072c68efb7620), [`0f07403`](https://github.com/vercel/workflow/commit/0f074030a408078e7db0ae0e494f64125d7444e4), [`2cc42cb`](https://github.com/vercel/workflow/commit/2cc42cb8a934532d9ce5b05185322a2f9ce76024), [`94c14c7`](https://github.com/vercel/workflow/commit/94c14c746b3218d13a5e2a7936c8cef505e7be08), [`f52afe7`](https://github.com/vercel/workflow/commit/f52afe77fffb981dd8812b84b39c2ecab2288f43)]:
  - @workflow/world-local@4.1.0-beta.44
  - @workflow/core@4.2.0-beta.71
  - @workflow/builders@4.0.1-beta.62
  - @workflow/world@4.1.0-beta.13
  - @workflow/rollup@4.0.0-beta.28

## 4.0.1-beta.7

### Patch Changes

- [#1346](https://github.com/vercel/workflow/pull/1346) [`73c12f1`](https://github.com/vercel/workflow/commit/73c12f14dabb465e2074e2aebbcd231a4d91bc09) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix `ERR_UNSUPPORTED_ESM_URL_SCHEME` on Windows by converting absolute file paths to `file://` URLs before passing them to dynamic `import()`

- Updated dependencies [[`7df1385`](https://github.com/vercel/workflow/commit/7df13854f85529929ff1187fe831f4dbc51b9121), [`9feebee`](https://github.com/vercel/workflow/commit/9feebee15c7c35843b99254b23a2f7743ea3f8c6), [`58e67ce`](https://github.com/vercel/workflow/commit/58e67ce11bd69b982214e2734363fa7fd252f5f6)]:
  - @workflow/core@4.2.0-beta.70
  - @workflow/world-local@4.1.0-beta.43
  - @workflow/builders@4.0.1-beta.61
  - @workflow/rollup@4.0.0-beta.27

## 4.0.1-beta.6

### Patch Changes

- Updated dependencies [[`825417a`](https://github.com/vercel/workflow/commit/825417acbaf7f721259427ecf4b7bc2a0e5cbef7), [`825417a`](https://github.com/vercel/workflow/commit/825417acbaf7f721259427ecf4b7bc2a0e5cbef7), [`fb5a500`](https://github.com/vercel/workflow/commit/fb5a500eadba80efdef75e3ccf6e85e957820f38), [`3648109`](https://github.com/vercel/workflow/commit/3648109861f1fbfe24101936dc35c9a36650b7e2), [`d72c822`](https://github.com/vercel/workflow/commit/d72c82220f0c56bb26edbc918e485b8bd14c959b)]:
  - @workflow/core@4.2.0-beta.69
  - @workflow/world@4.1.0-beta.12
  - @workflow/world-local@4.1.0-beta.42
  - @workflow/builders@4.0.1-beta.60
  - @workflow/rollup@4.0.0-beta.26

## 4.0.1-beta.5

### Patch Changes

- Updated dependencies [[`83dbd46`](https://github.com/vercel/workflow/commit/83dbd46456a8dbfc89efd87895929cbb813feda3), [`4a6ddd8`](https://github.com/vercel/workflow/commit/4a6ddd82c0fc1b3768f3a10befad77f43e81036e), [`854a25f`](https://github.com/vercel/workflow/commit/854a25f9103f5f3a5769dec6e3e5c6b98ed119b0)]:
  - @workflow/core@4.2.0-beta.68
  - @workflow/world-local@4.1.0-beta.41
  - @workflow/builders@4.0.1-beta.59
  - @workflow/rollup@4.0.0-beta.25

## 4.0.1-beta.4

### Patch Changes

- Updated dependencies [[`c71befe`](https://github.com/vercel/workflow/commit/c71befe8ec73765e67b7f2e0627251643ab245d4), [`36a901d`](https://github.com/vercel/workflow/commit/36a901d2d2f2ba37ec024073a7dd39a094b9e9c0), [`d8daa2a`](https://github.com/vercel/workflow/commit/d8daa2a9a95e2d01a4e6fee4e8dde51d82db762d)]:
  - @workflow/core@4.2.0-beta.67
  - @workflow/world@4.1.0-beta.11
  - @workflow/world-local@4.1.0-beta.40
  - @workflow/builders@4.0.1-beta.58
  - @workflow/rollup@4.0.0-beta.24

## 4.0.1-beta.3

### Patch Changes

- Updated dependencies [[`8b5a388`](https://github.com/vercel/workflow/commit/8b5a388a9451d7c7460481f0889da5037bd90893), [`dff00c9`](https://github.com/vercel/workflow/commit/dff00c94008f60cbfb4a398f2b98101d80ee8377)]:
  - @workflow/core@4.2.0-beta.66
  - @workflow/world-local@4.1.0-beta.39
  - @workflow/builders@4.0.1-beta.57
  - @workflow/rollup@4.0.0-beta.23

## 4.0.1-beta.2

### Patch Changes

- [#1237](https://github.com/vercel/workflow/pull/1237) [`456c1aa`](https://github.com/vercel/workflow/commit/456c1aa455d9d391a954b25e3d86ee9b06ad2f30) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add `@workflow/vitest` plugin for Vitest for running full workflows inside the test runner

- Updated dependencies [[`456c1aa`](https://github.com/vercel/workflow/commit/456c1aa455d9d391a954b25e3d86ee9b06ad2f30), [`11dcb64`](https://github.com/vercel/workflow/commit/11dcb646d33e7a2b251d9388c2c8ecdd6aca73f7)]:
  - @workflow/world-local@4.1.0-beta.38
  - @workflow/world@4.1.0-beta.10
  - @workflow/core@4.2.0-beta.65
  - @workflow/builders@4.0.1-beta.56
  - @workflow/rollup@4.0.0-beta.22
