# @workflow/builders

## 4.0.1-beta.48

### Patch Changes

- Updated dependencies []:
  - @workflow/core@4.1.0-beta.57

## 4.0.1-beta.47

### Patch Changes

- [#1029](https://github.com/vercel/workflow/pull/1029) [`94760b4`](https://github.com/vercel/workflow/commit/94760b4640dde4ed84ff0932994ce9a47b1954ad) Thanks [@ijjk](https://github.com/ijjk)! - Track loader transform deps instead of clearing Next cache

- Updated dependencies [[`c56dc38`](https://github.com/vercel/workflow/commit/c56dc3848ecf3e188f876dc4cb7861df185bd4fb), [`d7d005b`](https://github.com/vercel/workflow/commit/d7d005b54b621214720518a2a19aa2cadfa23d47), [`8d117cd`](https://github.com/vercel/workflow/commit/8d117cd219faac53ffa90db8628defd3d7a8160d), [`63caf93`](https://github.com/vercel/workflow/commit/63caf931380b8211f1948cf44eac7532f33e660d), [`dc2dc6a`](https://github.com/vercel/workflow/commit/dc2dc6ac7908e57be9ab34140addfe98a9246fc7)]:
  - @workflow/core@4.1.0-beta.56

## 4.0.1-beta.46

### Patch Changes

- [#998](https://github.com/vercel/workflow/pull/998) [`3d770d5`](https://github.com/vercel/workflow/commit/3d770d53855ce7c8522d4f0afbdbc123eae6c1ee) Thanks [@ijjk](https://github.com/ijjk)! - Expose workflows manifest under diagnostics folder

- [#976](https://github.com/vercel/workflow/pull/976) [`a5935ab`](https://github.com/vercel/workflow/commit/a5935abec7c7e57b2a89c629203d567cd7ac76a7) Thanks [@ijjk](https://github.com/ijjk)! - Add lazy workflow/step discovery via deferredEntries in next

- [#908](https://github.com/vercel/workflow/pull/908) [`1adcc6a`](https://github.com/vercel/workflow/commit/1adcc6a618562e0b31ae53d10f9f6aa797107705) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix discovery of serde classes to detect `[WORKFLOW_SERIALIZE]` and `[WORKFLOW_DESERIALIZE]` computed property usage in bundled code

- Updated dependencies [[`3d770d5`](https://github.com/vercel/workflow/commit/3d770d53855ce7c8522d4f0afbdbc123eae6c1ee), [`054e40c`](https://github.com/vercel/workflow/commit/054e40c91be615809c71d3ad29573c78c4491825), [`a5935ab`](https://github.com/vercel/workflow/commit/a5935abec7c7e57b2a89c629203d567cd7ac76a7), [`fc4cad6`](https://github.com/vercel/workflow/commit/fc4cad68088b0f4fa4e5eeb828e2af29e05d4fe1), [`56f2221`](https://github.com/vercel/workflow/commit/56f22219b338a5a2c29466798a5ad36a6a450498)]:
  - @workflow/utils@4.1.0-beta.12
  - @workflow/core@4.1.0-beta.55
  - @workflow/swc-plugin@4.1.0-beta.18
  - @workflow/errors@4.1.0-beta.15

## 4.0.1-beta.45

### Patch Changes

- [#972](https://github.com/vercel/workflow/pull/972) [`2d1d69f`](https://github.com/vercel/workflow/commit/2d1d69f4ca7be9cf6d01aa2dfb9b031d74ba166c) Thanks [@ijjk](https://github.com/ijjk)! - Fix getImportPath package handling

- Updated dependencies [[`fcfaf8b`](https://github.com/vercel/workflow/commit/fcfaf8bbaa912b1767c646592e539d5f98cd1e9c), [`d9e9859`](https://github.com/vercel/workflow/commit/d9e98590fae17fd090e0be4f0b54bbaa80c7be69), [`ef23b0b`](https://github.com/vercel/workflow/commit/ef23b0be770bbb5ccca015fb2564953fe6a761d7), [`f7fd88e`](https://github.com/vercel/workflow/commit/f7fd88ea963e127e62c8d527dcfdb895ba646fc2), [`fcfaf8b`](https://github.com/vercel/workflow/commit/fcfaf8bbaa912b1767c646592e539d5f98cd1e9c)]:
  - @workflow/core@4.1.0-beta.54
  - @workflow/swc-plugin@4.1.0-beta.17
  - @workflow/errors@4.1.0-beta.14

## 4.0.1-beta.44

### Patch Changes

- [#901](https://github.com/vercel/workflow/pull/901) [`35a9f0c`](https://github.com/vercel/workflow/commit/35a9f0cb0360ffc48c8a8e7db3a299924ab48375) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix module specifier cache bug and add subpath export resolution for package IDs

- [#931](https://github.com/vercel/workflow/pull/931) [`2453b29`](https://github.com/vercel/workflow/commit/2453b29426d79497076bc910c23cac887beefc0d) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Make `wf build --manifest-file` include steps / classes metadata

- [#874](https://github.com/vercel/workflow/pull/874) [`b5296a7`](https://github.com/vercel/workflow/commit/b5296a7a32b9037aa03c71d87e785fa2d5384a11) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add discovered serializable classes in all context modes

- [#899](https://github.com/vercel/workflow/pull/899) [`73bf7be`](https://github.com/vercel/workflow/commit/73bf7be925a8ffc0c6fce0cc75b6092243882088) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Change compiler ID generation logic to use Node.js import specifiers

  IDs for workflows, steps, and classes now use module specifiers:
  - Local files use `./path/to/file` format instead of `path/to/file.ext`
  - Package files use `packageName@version` format (e.g., `workflow@4.0.1`)

  This enables stable IDs across different package.json export conditions.

- [#963](https://github.com/vercel/workflow/pull/963) [`661724c`](https://github.com/vercel/workflow/commit/661724c01e78691abad26fa99bd44f254a70f2dd) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Expose workflow manifest via HTTP when `WORKFLOW_PUBLIC_MANIFEST=1`

- [#859](https://github.com/vercel/workflow/pull/859) [`8114792`](https://github.com/vercel/workflow/commit/8114792600a851fbf14cf41f8340e646aef36368) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add discovery for custom classes with workflow serialization

- Updated dependencies [[`0ce46b9`](https://github.com/vercel/workflow/commit/0ce46b91d9c8ca3349f43cdf3a5d75a948d6f5ad), [`35a9f0c`](https://github.com/vercel/workflow/commit/35a9f0cb0360ffc48c8a8e7db3a299924ab48375), [`f090de1`](https://github.com/vercel/workflow/commit/f090de1eb48ad8ec3fd776e9d084310d56a7ac29), [`79e988f`](https://github.com/vercel/workflow/commit/79e988fa85f0ebdd5c8913b8de84e01c55d020b9), [`b9c782d`](https://github.com/vercel/workflow/commit/b9c782d75f5452265764cd36d5e306060f8703c3), [`c54ba21`](https://github.com/vercel/workflow/commit/c54ba21c19040577ed95f6264a2670f190e1d1d3), [`b5296a7`](https://github.com/vercel/workflow/commit/b5296a7a32b9037aa03c71d87e785fa2d5384a11), [`c1d7c8d`](https://github.com/vercel/workflow/commit/c1d7c8dbb44afb7434acb07fee500ecaa1224fb0), [`e0061b8`](https://github.com/vercel/workflow/commit/e0061b861d0e3c3dc15853aed331fb1bbab71408), [`38e8d55`](https://github.com/vercel/workflow/commit/38e8d5571d2ee4b80387943f8f39a93b6e4bc751), [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6), [`73bf7be`](https://github.com/vercel/workflow/commit/73bf7be925a8ffc0c6fce0cc75b6092243882088), [`efb33b2`](https://github.com/vercel/workflow/commit/efb33b2b5edf6ccb1ec2f02f1d99f2a009333780), [`8114792`](https://github.com/vercel/workflow/commit/8114792600a851fbf14cf41f8340e646aef36368), [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6)]:
  - @workflow/core@4.1.0-beta.53
  - @workflow/swc-plugin@4.1.0-beta.16
  - @workflow/errors@4.1.0-beta.14

## 4.0.1-beta.43

### Patch Changes

- [#911](https://github.com/vercel/workflow/pull/911) [`f40532a`](https://github.com/vercel/workflow/commit/f40532a8720b9b0ecb3cf4983cbfd86065503567) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Fix workflow bundle to inline pseudo-packages instead of marking them external

- Updated dependencies [[`e4e3281`](https://github.com/vercel/workflow/commit/e4e32812f8f181ad4db72e76f62ba1edf2477b12)]:
  - @workflow/core@4.1.0-beta.52

## 4.0.1-beta.42

### Patch Changes

- [#840](https://github.com/vercel/workflow/pull/840) [`50f50f4`](https://github.com/vercel/workflow/commit/50f50f44d79a3cf1102173ff1865cd8a01723ea3) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Create `@workflow/nest` package and add build support for NestJS

- [#831](https://github.com/vercel/workflow/pull/831) [`0b5cc48`](https://github.com/vercel/workflow/commit/0b5cc4814094ecb8ec5be8eb5339c04d97b55c8b) Thanks [@michael-han-dev](https://github.com/michael-han-dev)! - Fix manifest missing workflow-only files (no steps)

- [#898](https://github.com/vercel/workflow/pull/898) [`13d4cee`](https://github.com/vercel/workflow/commit/13d4ceef74e1e51b6471df6a85f03b3b967c3da4) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Use proper pluralization in the builder log line

- [#800](https://github.com/vercel/workflow/pull/800) [`4ad3fcd`](https://github.com/vercel/workflow/commit/4ad3fcd0a362f3d83a6c272dec6362fe9a562c63) Thanks [@alandotcom](https://github.com/alandotcom)! - Pass runtime option to Vercel Build Output API functions

- [#864](https://github.com/vercel/workflow/pull/864) [`81c5a83`](https://github.com/vercel/workflow/commit/81c5a835ae647cd94d88ccec8c3b037acdfb6598) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add "classes" object to `manifest.json` file

- Updated dependencies [[`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`a2b688d`](https://github.com/vercel/workflow/commit/a2b688d0623ebbae117877a696c5b9b288d628fd), [`244b94a`](https://github.com/vercel/workflow/commit/244b94a0665087ece694ae881a17d6aaa0ca0a7f), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`1f684df`](https://github.com/vercel/workflow/commit/1f684df6b7b9cd322d5f1aa4a70dcaa3e07c7986), [`81c5a83`](https://github.com/vercel/workflow/commit/81c5a835ae647cd94d88ccec8c3b037acdfb6598), [`b4113da`](https://github.com/vercel/workflow/commit/b4113da9541f3cebf1605d753374025f95259bf8), [`b16a682`](https://github.com/vercel/workflow/commit/b16a6828af36a2d5adb38fb6a6d1253657001ac8), [`bd8116d`](https://github.com/vercel/workflow/commit/bd8116d40bf8d662537bf015d2861f6d1768d69e), [`1060f9d`](https://github.com/vercel/workflow/commit/1060f9d04a372bf6de6c5c3d52063bcc22dba6e8), [`00c7961`](https://github.com/vercel/workflow/commit/00c7961ecb09418d6c23e1346a1b6569eb66a6bf), [`c45bc3f`](https://github.com/vercel/workflow/commit/c45bc3fd15ca201ee568cf7789ff1467cf7ba566)]:
  - @workflow/errors@4.1.0-beta.14
  - @workflow/core@4.1.0-beta.51
  - @workflow/swc-plugin@4.1.0-beta.15
  - @workflow/utils@4.1.0-beta.11

## 4.0.1-beta.41

### Patch Changes

- Updated dependencies [[`5ba82ec`](https://github.com/vercel/workflow/commit/5ba82ec4b105d11538be6ad65449986eaf945916)]:
  - @workflow/core@4.0.1-beta.41

## 4.0.1-beta.40

### Patch Changes

- Updated dependencies [[`1843704`](https://github.com/vercel/workflow/commit/1843704b83d5aaadcf1e4f5f1c73c150bd0bd2a3), [`f93e894`](https://github.com/vercel/workflow/commit/f93e894a6a95a194637dc2ea8b19e1ad0b7653eb)]:
  - @workflow/swc-plugin@4.0.1-beta.14
  - @workflow/core@4.0.1-beta.40

## 4.0.1-beta.39

### Patch Changes

- Updated dependencies [[`344c90f`](https://github.com/vercel/workflow/commit/344c90ff9f630addc4b41f72c2296b26e61513bc), [`b729d49`](https://github.com/vercel/workflow/commit/b729d49610739ae818fd56853f8ddc557591e9a1)]:
  - @workflow/core@4.0.1-beta.39

## 4.0.1-beta.38

### Patch Changes

- Updated dependencies [[`7906429`](https://github.com/vercel/workflow/commit/7906429541672049821ec8b74452c99868db6290), [`7906429`](https://github.com/vercel/workflow/commit/7906429541672049821ec8b74452c99868db6290), [`a2fc53a`](https://github.com/vercel/workflow/commit/a2fc53a0dc2df0648ae9e7fd59aae044a612ebcb)]:
  - @workflow/swc-plugin@4.0.1-beta.13
  - @workflow/core@4.0.1-beta.38

## 4.0.1-beta.37

### Patch Changes

- Updated dependencies [[`61fdb41`](https://github.com/vercel/workflow/commit/61fdb41e1b5cd52c7b23fa3c0f3fcaa50c4189ca), [`3dd5b27`](https://github.com/vercel/workflow/commit/3dd5b2708de56e63c9dce9b3f2eafea63b0e3936), [`49f650c`](https://github.com/vercel/workflow/commit/49f650c3a79e7b9b501cb602e3c12b75a3c4fffc), [`39e5774`](https://github.com/vercel/workflow/commit/39e5774de2a4c8b6a18574aa4edaf79e9f0d655e)]:
  - @workflow/core@4.0.1-beta.37
  - @workflow/errors@4.0.1-beta.13

## 4.0.1-beta.36

### Patch Changes

- Updated dependencies []:
  - @workflow/core@4.0.1-beta.36
  - @workflow/errors@4.0.1-beta.13

## 4.0.1-beta.35

### Patch Changes

- [#720](https://github.com/vercel/workflow/pull/720) [`4d6f797`](https://github.com/vercel/workflow/commit/4d6f797274331b2efa69576dda7361ef7f704edf) Thanks [@pranaygp](https://github.com/pranaygp)! - Enable source maps for step bundles to preserve original file paths in error stack traces

- [#731](https://github.com/vercel/workflow/pull/731) [`505063c`](https://github.com/vercel/workflow/commit/505063cbb9ef04af8531c2cd3cd3840b5d272f82) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Special-case "server-only" and "client-only" packages as external

- Updated dependencies [[`4d6f797`](https://github.com/vercel/workflow/commit/4d6f797274331b2efa69576dda7361ef7f704edf)]:
  - @workflow/core@4.0.1-beta.35

## 4.0.1-beta.34

### Patch Changes

- [#713](https://github.com/vercel/workflow/pull/713) [`d552374`](https://github.com/vercel/workflow/commit/d552374b13945c76cbffccfcfdef38f4e3b5a97c) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Resolve `@workflow/swc-plugin` relative to the "builders" package

## 4.0.1-beta.33

### Patch Changes

- [#712](https://github.com/vercel/workflow/pull/712) [`307f4b0`](https://github.com/vercel/workflow/commit/307f4b0e41277f6b32afbfa361d8c6ca1b3d7f6c) Thanks [@ijjk](https://github.com/ijjk)! - Revert lazy workflow and step discovery

- [#705](https://github.com/vercel/workflow/pull/705) [`7ff68d1`](https://github.com/vercel/workflow/commit/7ff68d1753c43b14d161d249f6745de6beddd99b) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Pass `tsconfig` to esbuild for support of "paths" aliases

- Updated dependencies [[`9b1640d`](https://github.com/vercel/workflow/commit/9b1640d76e7e759446058d65272011071bb250d2), [`307f4b0`](https://github.com/vercel/workflow/commit/307f4b0e41277f6b32afbfa361d8c6ca1b3d7f6c)]:
  - @workflow/core@4.0.1-beta.34
  - @workflow/errors@4.0.1-beta.13

## 4.0.1-beta.32

### Patch Changes

- Updated dependencies []:
  - @workflow/core@4.0.1-beta.33

## 4.0.1-beta.31

### Patch Changes

- [#455](https://github.com/vercel/workflow/pull/455) [`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Added Control Flow Graph extraction from Workflows and extended manifest.json's schema to incorporate the graph structure into it. Refactored manifest generation to pass manifest as a parameter instead of using instance state. Add e2e tests for manifest validation across all builders.

- Updated dependencies [[`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6)]:
  - @workflow/core@4.0.1-beta.32
  - @workflow/errors@4.0.1-beta.12

## 4.0.1-beta.30

### Patch Changes

- [#640](https://github.com/vercel/workflow/pull/640) [`ea3afce`](https://github.com/vercel/workflow/commit/ea3afce222ff9c2f90d99414fae275ef5f54b431) Thanks [@ijjk](https://github.com/ijjk)! - Add lazy workflow and step discovery in Next.js

- Updated dependencies [[`25b02b0`](https://github.com/vercel/workflow/commit/25b02b0bfdefa499e13fb974b1832fbe47dbde86)]:
  - @workflow/core@4.0.1-beta.31
  - @workflow/errors@4.0.1-beta.11

## 4.0.1-beta.29

### Patch Changes

- Updated dependencies []:
  - @workflow/core@4.0.1-beta.30

## 4.0.1-beta.28

### Patch Changes

- Updated dependencies [[`eaf9aa6`](https://github.com/vercel/workflow/commit/eaf9aa65f354bf1e22e8e148c0fd1936f0ec9358)]:
  - @workflow/core@4.0.1-beta.29

## 4.0.1-beta.27

### Patch Changes

- Updated dependencies [[`ea2a67e`](https://github.com/vercel/workflow/commit/ea2a67e19c5d224b4b4fd1c1a417810562df0807), [`712f6f8`](https://github.com/vercel/workflow/commit/712f6f86b1804c82d4cab3bba0db49584451d005), [`4bdd3e5`](https://github.com/vercel/workflow/commit/4bdd3e5086a51a46898cca774533019d3ace77b3)]:
  - @workflow/core@4.0.1-beta.28
  - @workflow/errors@4.0.1-beta.10

## 4.0.1-beta.26

### Patch Changes

- Updated dependencies [[`deaf019`](https://github.com/vercel/workflow/commit/deaf0193e91ea7a24d2423a813b64f51faa681e3), [`b56aae3`](https://github.com/vercel/workflow/commit/b56aae3fe9b5568d7bdda592ed025b3499149240), [`4d7a393`](https://github.com/vercel/workflow/commit/4d7a393906846be751e798c943594bec3c9b0ff3)]:
  - @workflow/core@4.0.1-beta.27
  - @workflow/errors@4.0.1-beta.9

## 4.0.1-beta.25

### Patch Changes

- Updated dependencies [[`696e7e3`](https://github.com/vercel/workflow/commit/696e7e31e88eae5d86e9d4b9f0344f0777ae9673)]:
  - @workflow/core@4.0.1-beta.26
  - @workflow/errors@4.0.1-beta.8

## 4.0.1-beta.24

### Patch Changes

- [#503](https://github.com/vercel/workflow/pull/503) [`19c271c`](https://github.com/vercel/workflow/commit/19c271c0725f263ebbcbd87e68240547c1acbe2f) Thanks [@adriandlam](https://github.com/adriandlam)! - Refactor request converter code in SvelteKit and Astro builder to @workflow/builders

- Updated dependencies [[`161c54c`](https://github.com/vercel/workflow/commit/161c54ca13e0c36220640e656b7abe4ff282dbb0), [`0bbd26f`](https://github.com/vercel/workflow/commit/0bbd26f8c85a04dea3dc87a11c52e9ac63a18e84), [`c35b445`](https://github.com/vercel/workflow/commit/c35b4458753cc116b90d61f470f7ab1d964e8a1e), [`d3fd81d`](https://github.com/vercel/workflow/commit/d3fd81dffd87abbd1a3d8a8e91e9781959eefd40)]:
  - @workflow/core@4.0.1-beta.25
  - @workflow/errors@4.0.1-beta.7

## 4.0.1-beta.23

### Patch Changes

- fc774e5: Fix esbuild node module plugin to show top level violation and preview file
- 21cff15: Add support for `.mjs`, `.mts`, `.cjs`, and `.cts` file extensions in the SWC transform
  - Updated turbopack rules to include `*.mjs`, `*.mts`, `*.cjs`, `*.cts` in addition to existing extensions
  - Fixed TypeScript detection for `.mts` and `.cts` files across all transform plugins
  - Updated esbuild `resolveExtensions` to include `.mts` and `.cts`
  - Updated the file watcher's `watchableExtensions` to include `.cts`

- 43f2dec: Improved workflow registration in workflow mode
  - SWC plugin now emits `globalThis.__private_workflows.set(workflowId, fn)` directly after setting `workflowId`
  - Non-exported workflow functions are now properly registered and can be invoked
  - Removed runtime iteration over exports in the workflow bundle - registration happens at transform time
  - Simplified virtual entry generation in base-builder

- Updated dependencies [fa37d26]
- Updated dependencies [f46c51e]
- Updated dependencies [af5b005]
- Updated dependencies [43f2dec]
  - @workflow/swc-plugin@4.0.1-beta.12
  - @workflow/core@4.0.1-beta.24
  - @workflow/errors@4.0.1-beta.7

## 4.0.1-beta.22

### Patch Changes

- @workflow/core@4.0.1-beta.23

## 4.0.1-beta.21

### Patch Changes

- ac7997b: Update to latest swc/core and preserve JSX
- Updated dependencies [ac7997b]
- Updated dependencies [02c41cc]
  - @workflow/swc-plugin@4.0.1-beta.11
  - @workflow/core@4.0.1-beta.22

## 4.0.1-beta.20

### Patch Changes

- Updated dependencies [2f0840b]
- Updated dependencies [555d7a6]
  - @workflow/core@4.0.1-beta.21
  - @workflow/swc-plugin@4.0.1-beta.10

## 4.0.1-beta.19

### Patch Changes

- d53bf90: Fix StandaloneBuilder to scan all directories for workflows
- 3c19e90: Fix Nitro and SvelteKit build race conditions and make writing debug file atomic
- 1ac5592: Add @workflow/astro package
- Updated dependencies [0f1645b]
- Updated dependencies [5b91861]
- Updated dependencies [bdde1bd]
- Updated dependencies [0cacb99]
- Updated dependencies [8d4562e]
  - @workflow/core@4.0.1-beta.20
  - @workflow/swc-plugin@4.0.1-beta.9
  - @workflow/errors@4.0.1-beta.7

## 4.0.1-beta.18

### Patch Changes

- b042ba7: Externalize bun from step bundles
- Updated dependencies [07800c2]
- Updated dependencies [fb9fd0f]
- Updated dependencies [8b470f0]
  - @workflow/core@4.0.1-beta.19
  - @workflow/swc-plugin@4.0.1-beta.8
  - @workflow/errors@4.0.1-beta.6

## 4.0.1-beta.17

### Patch Changes

- @workflow/core@4.0.1-beta.18

## 4.0.1-beta.16

### Patch Changes

- @workflow/core@4.0.1-beta.17
- @workflow/errors@4.0.1-beta.6

## 4.0.1-beta.15

### Patch Changes

- 73b6c68: Remove suppressUndefinedRejection from BaseBuilder
- Updated dependencies [3436629]
- Updated dependencies [9961140]
- Updated dependencies [73b6c68]
  - @workflow/core@4.0.1-beta.16

## 4.0.1-beta.14

### Patch Changes

- Updated dependencies [e5c5236]
  - @workflow/swc-plugin@4.0.1-beta.7

## 4.0.1-beta.13

### Patch Changes

- Updated dependencies [3d99d6d]
  - @workflow/core@4.0.1-beta.15

## 4.0.1-beta.12

### Patch Changes

- Updated dependencies [6e41c90]
  - @workflow/core@4.0.1-beta.14

## 4.0.1-beta.11

### Patch Changes

- Updated dependencies [2fde24e]
- Updated dependencies [4b70739]
  - @workflow/core@4.0.1-beta.13
  - @workflow/errors@4.0.1-beta.5

## 4.0.1-beta.10

### Patch Changes

- 8e96134: Add .svelte-kit to ignored paths
- b97b6bf: Lock all dependencies in our packages
- Updated dependencies [5eb588a]
- Updated dependencies [00b0bb9]
- Updated dependencies [0b848cd]
- Updated dependencies [85ce8e0]
- Updated dependencies [b97b6bf]
- Updated dependencies [45b7b41]
- Updated dependencies [00b0bb9]
- Updated dependencies [f8e5d10]
- Updated dependencies [6be03f3]
- Updated dependencies [8002e0f]
- Updated dependencies [f07b2da]
- Updated dependencies [aecdcdf]
  - @workflow/swc-plugin@4.0.1-beta.6
  - @workflow/core@4.0.1-beta.12
  - @workflow/errors@4.0.1-beta.5

## 4.0.1-beta.9

### Patch Changes

- 8208b53: Fix sourcemap error tracing in workflows
- Updated dependencies [8208b53]
- Updated dependencies [4f9ae4e]
- Updated dependencies [aac1b6c]
- Updated dependencies [6373ab5]
  - @workflow/core@4.0.1-beta.11
  - @workflow/swc-plugin@4.0.1-beta.5

## 4.0.1-beta.8

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
  - @workflow/errors@4.0.1-beta.4

## 4.0.1-beta.7

### Patch Changes

- Updated dependencies [9f56434]
  - @workflow/core@4.0.1-beta.9

## 4.0.1-beta.6

### Patch Changes

- c2fa9df: Fix node module esbuild plugin file regex filter

## 4.0.1-beta.5

### Patch Changes

- 4a821fc: Fix Windows path handling by normalizing backslashes to forward slashes in workflow IDs
- Updated dependencies [4a821fc]
- Updated dependencies [4a821fc]
  - @workflow/swc-plugin@4.0.1-beta.3
  - @workflow/core@4.0.1-beta.8

## 4.0.1-beta.4

### Patch Changes

- 80d68b7: Add comprehensive documentation to BaseBuilder
- 744d82f: Add type safety for builder configurations with discriminated unions
- ebee7f5: Consolidate builder configuration patterns
- 652485a: Create @workflow/builders package with shared builder infrastructure
- 4585222: Deduplicate package.json and .vc-config.json generation
- 10bfd4a: Extract path resolution and directory creation helpers
- 5dfa4eb: Extract queue trigger configuration constants
- 05714f7: Add sveltekit workflow integration
- f8c779e: Improve error handling in bundle creation methods
- bf54a7b: Standardize method naming conventions
- Updated dependencies [05714f7]
  - @workflow/core@4.0.1-beta.7
