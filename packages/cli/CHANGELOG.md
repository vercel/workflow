# @workflow/cli

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
- dbf2207: Fix --backend flag not finding world when using embedded world package name explicitly
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
