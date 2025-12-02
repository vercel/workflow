# @workflow/builders

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
