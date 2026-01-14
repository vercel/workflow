# @workflow/rollup

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
