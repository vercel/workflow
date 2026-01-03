# @workflow/sveltekit

## 4.0.0-beta.32

### Patch Changes

- Updated dependencies [[`d552374`](https://github.com/vercel/workflow/commit/d552374b13945c76cbffccfcfdef38f4e3b5a97c)]:
  - @workflow/builders@4.0.1-beta.34
  - @workflow/vite@4.0.0-beta.2

## 4.0.0-beta.31

### Patch Changes

- [#705](https://github.com/vercel/workflow/pull/705) [`7ff68d1`](https://github.com/vercel/workflow/commit/7ff68d1753c43b14d161d249f6745de6beddd99b) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Pass `tsconfig` to esbuild for support of "paths" aliases

- Updated dependencies [[`307f4b0`](https://github.com/vercel/workflow/commit/307f4b0e41277f6b32afbfa361d8c6ca1b3d7f6c), [`7ff68d1`](https://github.com/vercel/workflow/commit/7ff68d1753c43b14d161d249f6745de6beddd99b)]:
  - @workflow/builders@4.0.1-beta.33
  - @workflow/vite@4.0.0-beta.2

## 4.0.0-beta.30

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.32
  - @workflow/vite@4.0.0-beta.2

## 4.0.0-beta.29

### Patch Changes

- [#455](https://github.com/vercel/workflow/pull/455) [`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Added Control Flow Graph extraction from Workflows and extended manifest.json's schema to incorporate the graph structure into it. Refactored manifest generation to pass manifest as a parameter instead of using instance state. Add e2e tests for manifest validation across all builders.

- Updated dependencies [[`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6)]:
  - @workflow/builders@4.0.1-beta.31
  - @workflow/vite@4.0.0-beta.2

## 4.0.0-beta.28

### Patch Changes

- Updated dependencies [[`ea3afce`](https://github.com/vercel/workflow/commit/ea3afce222ff9c2f90d99414fae275ef5f54b431)]:
  - @workflow/builders@4.0.1-beta.30
  - @workflow/vite@4.0.0-beta.2

## 4.0.0-beta.27

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.29
  - @workflow/vite@4.0.0-beta.2

## 4.0.0-beta.26

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.28
  - @workflow/vite@4.0.0-beta.2

## 4.0.0-beta.25

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.27
  - @workflow/vite@4.0.0-beta.2

## 4.0.0-beta.24

### Patch Changes

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.26
  - @workflow/vite@4.0.0-beta.2

## 4.0.0-beta.23

### Patch Changes

- [#573](https://github.com/vercel/workflow/pull/573) [`8d2cabe`](https://github.com/vercel/workflow/commit/8d2cabe27e80979a5f3cfb4fef373ca3938b5950) Thanks [@adriandlam](https://github.com/adriandlam)! - Externalize SvelteKit virtual modules in builder

- [#590](https://github.com/vercel/workflow/pull/590) [`c9b8d84`](https://github.com/vercel/workflow/commit/c9b8d843fd0a88de268d603a14ebe2e7c726169a) Thanks [@adriandlam](https://github.com/adriandlam)! - Improve port detection with HTTP probing

- Updated dependencies []:
  - @workflow/builders@4.0.1-beta.25
  - @workflow/vite@4.0.0-beta.2

## 4.0.0-beta.22

### Patch Changes

- [#503](https://github.com/vercel/workflow/pull/503) [`19c271c`](https://github.com/vercel/workflow/commit/19c271c0725f263ebbcbd87e68240547c1acbe2f) Thanks [@adriandlam](https://github.com/adriandlam)! - Refactor request converter code in SvelteKit and Astro builder to @workflow/builders

- [#501](https://github.com/vercel/workflow/pull/501) [`205b395`](https://github.com/vercel/workflow/commit/205b3953f047c665becb5be0ad3b5b92aefd54ce) Thanks [@adriandlam](https://github.com/adriandlam)! - Move Vite HMR to @workflow/vite package

- Updated dependencies [[`19c271c`](https://github.com/vercel/workflow/commit/19c271c0725f263ebbcbd87e68240547c1acbe2f), [`205b395`](https://github.com/vercel/workflow/commit/205b3953f047c665becb5be0ad3b5b92aefd54ce)]:
  - @workflow/builders@4.0.1-beta.24
  - @workflow/vite@4.0.0-beta.2

## 4.0.0-beta.21

### Patch Changes

- Updated dependencies [fc774e5]
- Updated dependencies [21cff15]
- Updated dependencies [fa37d26]
- Updated dependencies [f46c51e]
- Updated dependencies [af5b005]
- Updated dependencies [43f2dec]
  - @workflow/builders@4.0.1-beta.23
  - @workflow/rollup@4.0.0-beta.6
  - @workflow/swc-plugin@4.0.1-beta.12

## 4.0.0-beta.20

### Patch Changes

- @workflow/builders@4.0.1-beta.22

## 4.0.0-beta.19

### Patch Changes

- Updated dependencies [ac7997b]
  - @workflow/swc-plugin@4.0.1-beta.11
  - @workflow/builders@4.0.1-beta.21
  - @workflow/rollup@4.0.0-beta.5

## 4.0.0-beta.18

### Patch Changes

- Updated dependencies [555d7a6]
  - @workflow/swc-plugin@4.0.1-beta.10
  - @workflow/builders@4.0.1-beta.20
  - @workflow/rollup@4.0.0-beta.4

## 4.0.0-beta.17

### Patch Changes

- 3c19e90: Fix Nitro and SvelteKit build race conditions and make writing debug file atomic
- Updated dependencies [d53bf90]
- Updated dependencies [3c19e90]
- Updated dependencies [1ac5592]
- Updated dependencies [5b91861]
- Updated dependencies [0cacb99]
  - @workflow/builders@4.0.1-beta.19
  - @workflow/swc-plugin@4.0.1-beta.9
  - @workflow/rollup@4.0.0-beta.3

## 4.0.0-beta.16

### Patch Changes

- 6dd1750: Refactor to use @workflow/rollup package
- Updated dependencies [fb9fd0f]
- Updated dependencies [b042ba7]
- Updated dependencies [8b470f0]
- Updated dependencies [6dd1750]
  - @workflow/swc-plugin@4.0.1-beta.8
  - @workflow/builders@4.0.1-beta.18
  - @workflow/rollup@4.0.0-beta.2

## 4.0.0-beta.15

### Patch Changes

- @workflow/builders@4.0.1-beta.17

## 4.0.0-beta.14

### Patch Changes

- @workflow/builders@4.0.1-beta.16

## 4.0.0-beta.13

### Patch Changes

- 73b6c68: Remove suppressUndefinedRejection from BaseBuilder
- Updated dependencies [73b6c68]
  - @workflow/builders@4.0.1-beta.15

## 4.0.0-beta.12

### Patch Changes

- Updated dependencies [e5c5236]
  - @workflow/swc-plugin@4.0.1-beta.7
  - @workflow/builders@4.0.1-beta.14

## 4.0.0-beta.11

### Patch Changes

- @workflow/builders@4.0.1-beta.13

## 4.0.0-beta.10

### Patch Changes

- @workflow/builders@4.0.1-beta.12

## 4.0.0-beta.9

### Patch Changes

- @workflow/builders@4.0.1-beta.11

## 4.0.0-beta.8

### Patch Changes

- 945a946: Fix SvelteKit plugin reading deleted files on HMR
- b97b6bf: Lock all dependencies in our packages
- Updated dependencies [5eb588a]
- Updated dependencies [0b848cd]
- Updated dependencies [8e96134]
- Updated dependencies [b97b6bf]
- Updated dependencies [45b7b41]
- Updated dependencies [f8e5d10]
- Updated dependencies [8002e0f]
- Updated dependencies [f07b2da]
- Updated dependencies [aecdcdf]
  - @workflow/swc-plugin@4.0.1-beta.6
  - @workflow/builders@4.0.1-beta.10

## 4.0.0-beta.7

### Patch Changes

- Updated dependencies [8208b53]
- Updated dependencies [4f9ae4e]
  - @workflow/builders@4.0.1-beta.9
  - @workflow/swc-plugin@4.0.1-beta.5

## 4.0.0-beta.6

### Patch Changes

- 98c36f1: Use hotUpdate for HMR in sveltekit
- 03d076b: Remove unused deps in @workflow/sveltekit
- Updated dependencies [e0c6618]
  - @workflow/swc-plugin@4.0.1-beta.4
  - @workflow/builders@4.0.1-beta.8

## 4.0.0-beta.5

### Patch Changes

- 355cede: Replace setting global symbol with catching unhandled rejection in SvelteKit integration
  - @workflow/builders@4.0.1-beta.7

## 4.0.0-beta.4

### Patch Changes

- Updated dependencies [c2fa9df]
  - @workflow/builders@4.0.1-beta.6

## 4.0.0-beta.3

### Patch Changes

- 4a821fc: Fix Windows path handling by normalizing backslashes to forward slashes in workflow IDs
- Updated dependencies [4a821fc]
- Updated dependencies [4a821fc]
  - @workflow/swc-plugin@4.0.1-beta.3
  - @workflow/builders@4.0.1-beta.5

## 4.0.0-beta.2

### Patch Changes

- 05714f7: Add sveltekit workflow integration
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
  - @workflow/builders@4.0.1-beta.4
