# @workflow/rollup

## 4.0.0-beta.15

### Patch Changes

- Updated dependencies [[`1c11573`](https://github.com/vercel/workflow/commit/1c1157340d88c60c7c80c0789c111050b809ab77), [`29347b7`](https://github.com/vercel/workflow/commit/29347b79eae8181d02ed1e52183983adc56425fd)]:
  - @workflow/builders@4.0.1-beta.49

## 4.0.0-beta.14

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.48

## 4.0.0-beta.13

### Patch Changes

- Updated dependencies [[`94760b4`](https://github.com/vercel/workflow/commit/94760b4640dde4ed84ff0932994ce9a47b1954ad)]:
  - @workflow/builders@4.0.1-beta.47

## 4.0.0-beta.12

### Patch Changes

- Updated dependencies [[`3d770d5`](https://github.com/vercel/workflow/commit/3d770d53855ce7c8522d4f0afbdbc123eae6c1ee), [`054e40c`](https://github.com/vercel/workflow/commit/054e40c91be615809c71d3ad29573c78c4491825), [`a5935ab`](https://github.com/vercel/workflow/commit/a5935abec7c7e57b2a89c629203d567cd7ac76a7), [`1adcc6a`](https://github.com/vercel/workflow/commit/1adcc6a618562e0b31ae53d10f9f6aa797107705)]:
  - @workflow/builders@4.0.1-beta.46
  - @workflow/swc-plugin@4.1.0-beta.18

## 4.0.0-beta.11

### Patch Changes

- Updated dependencies [[`2d1d69f`](https://github.com/vercel/workflow/commit/2d1d69f4ca7be9cf6d01aa2dfb9b031d74ba166c), [`ef23b0b`](https://github.com/vercel/workflow/commit/ef23b0be770bbb5ccca015fb2564953fe6a761d7), [`fcfaf8b`](https://github.com/vercel/workflow/commit/fcfaf8bbaa912b1767c646592e539d5f98cd1e9c)]:
  - @workflow/builders@4.0.1-beta.45
  - @workflow/swc-plugin@4.1.0-beta.17

## 4.0.0-beta.10

### Patch Changes

- [#899](https://github.com/vercel/workflow/pull/899) [`73bf7be`](https://github.com/vercel/workflow/commit/73bf7be925a8ffc0c6fce0cc75b6092243882088) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Change compiler ID generation logic to use Node.js import specifiers

  IDs for workflows, steps, and classes now use module specifiers:
  - Local files use `./path/to/file` format instead of `path/to/file.ext`
  - Package files use `packageName@version` format (e.g., `workflow@4.0.1`)

  This enables stable IDs across different package.json export conditions.

- [#859](https://github.com/vercel/workflow/pull/859) [`8114792`](https://github.com/vercel/workflow/commit/8114792600a851fbf14cf41f8340e646aef36368) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add discovery for custom classes with workflow serialization

- Updated dependencies [[`35a9f0c`](https://github.com/vercel/workflow/commit/35a9f0cb0360ffc48c8a8e7db3a299924ab48375), [`2453b29`](https://github.com/vercel/workflow/commit/2453b29426d79497076bc910c23cac887beefc0d), [`b9c782d`](https://github.com/vercel/workflow/commit/b9c782d75f5452265764cd36d5e306060f8703c3), [`b5296a7`](https://github.com/vercel/workflow/commit/b5296a7a32b9037aa03c71d87e785fa2d5384a11), [`c1d7c8d`](https://github.com/vercel/workflow/commit/c1d7c8dbb44afb7434acb07fee500ecaa1224fb0), [`73bf7be`](https://github.com/vercel/workflow/commit/73bf7be925a8ffc0c6fce0cc75b6092243882088), [`661724c`](https://github.com/vercel/workflow/commit/661724c01e78691abad26fa99bd44f254a70f2dd), [`8114792`](https://github.com/vercel/workflow/commit/8114792600a851fbf14cf41f8340e646aef36368)]:
  - @workflow/swc-plugin@4.1.0-beta.16
  - @workflow/builders@4.0.1-beta.44

## 4.0.0-beta.9

### Patch Changes

- Updated dependencies [[`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`244b94a`](https://github.com/vercel/workflow/commit/244b94a0665087ece694ae881a17d6aaa0ca0a7f), [`81c5a83`](https://github.com/vercel/workflow/commit/81c5a835ae647cd94d88ccec8c3b037acdfb6598), [`b4113da`](https://github.com/vercel/workflow/commit/b4113da9541f3cebf1605d753374025f95259bf8)]:
  - @workflow/swc-plugin@4.1.0-beta.15

## 4.0.0-beta.8

### Patch Changes

- Updated dependencies [[`1843704`](https://github.com/vercel/workflow/commit/1843704b83d5aaadcf1e4f5f1c73c150bd0bd2a3)]:
  - @workflow/swc-plugin@4.0.1-beta.14

## 4.0.0-beta.7

### Patch Changes

- Updated dependencies [[`7906429`](https://github.com/vercel/workflow/commit/7906429541672049821ec8b74452c99868db6290), [`a2fc53a`](https://github.com/vercel/workflow/commit/a2fc53a0dc2df0648ae9e7fd59aae044a612ebcb)]:
  - @workflow/swc-plugin@4.0.1-beta.13

## 4.0.0-beta.6

### Patch Changes

- 21cff15: Add support for `.mjs`, `.mts`, `.cjs`, and `.cts` file extensions in the SWC transform
  - Updated turbopack rules to include `*.mjs`, `*.mts`, `*.cjs`, `*.cts` in addition to existing extensions
  - Fixed TypeScript detection for `.mts` and `.cts` files across all transform plugins
  - Updated esbuild `resolveExtensions` to include `.mts` and `.cts`
  - Updated the file watcher's `watchableExtensions` to include `.cts`

- Updated dependencies [fa37d26]
- Updated dependencies [f46c51e]
- Updated dependencies [af5b005]
- Updated dependencies [43f2dec]
  - @workflow/swc-plugin@4.0.1-beta.12

## 4.0.0-beta.5

### Patch Changes

- Updated dependencies [ac7997b]
  - @workflow/swc-plugin@4.0.1-beta.11

## 4.0.0-beta.4

### Patch Changes

- Updated dependencies [555d7a6]
  - @workflow/swc-plugin@4.0.1-beta.10

## 4.0.0-beta.3

### Patch Changes

- Updated dependencies [5b91861]
- Updated dependencies [0cacb99]
  - @workflow/swc-plugin@4.0.1-beta.9

## 4.0.0-beta.2

### Patch Changes

- 6dd1750: Refactor to use @workflow/rollup package
- Updated dependencies [fb9fd0f]
- Updated dependencies [8b470f0]
  - @workflow/swc-plugin@4.0.1-beta.8
