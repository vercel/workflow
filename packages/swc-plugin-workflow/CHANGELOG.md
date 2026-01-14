# @workflow/swc-plugin

## 4.0.1-beta.13

### Patch Changes

- [#754](https://github.com/vercel/workflow/pull/754) [`7906429`](https://github.com/vercel/workflow/commit/7906429541672049821ec8b74452c99868db6290) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add support for class reference serialization

- [#753](https://github.com/vercel/workflow/pull/753) [`a2fc53a`](https://github.com/vercel/workflow/commit/a2fc53a0dc2df0648ae9e7fd59aae044a612ebcb) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Support class static methods with "use step" / "use workflow"

## 4.0.1-beta.12

### Patch Changes

- fa37d26: Set `workflowId` property directly after function declarations
- f46c51e: Apply workflow transformation with `export { fnName }` syntax
- af5b005: Set `workflowId` property in workflow mode for non-exported workflow functions
- 43f2dec: Improved workflow registration in workflow mode

  - SWC plugin now emits `globalThis.__private_workflows.set(workflowId, fn)` directly after setting `workflowId`
  - Non-exported workflow functions are now properly registered and can be invoked
  - Removed runtime iteration over exports in the workflow bundle - registration happens at transform time
  - Simplified virtual entry generation in base-builder

## 4.0.1-beta.11

### Patch Changes

- ac7997b: Update to latest swc/core and preserve JSX

## 4.0.1-beta.10

### Patch Changes

- 555d7a6: Normalize anonymous default export workflow IDs to "default"

## 4.0.1-beta.9

### Patch Changes

- 5b91861: Apply workflow function transformation in "step" mode
- 0cacb99: Support nested "use step" declarations in non-workflow functions

## 4.0.1-beta.8

### Patch Changes

- fb9fd0f: Add support for closure scope vars in step functions
- 8b470f0: Apply SWC transformation on step functions returned from factory function

## 4.0.1-beta.7

### Patch Changes

- e5c5236: Fix default export workflow function transformation in workflow mode

## 4.0.1-beta.6

### Patch Changes

- 5eb588a: Remove step function identifier transform out of swc-plugin and into `useStep()` runtime function
- 0b848cd: Fix compiler warnings
- 45b7b41: Support nested anonymous step functions
- f8e5d10: Support serializing step function references
- 8002e0f: Add support for step functions defined as object properties
- f07b2da: Transform step functions to single `useStep()` calls
- aecdcdf: Add support for step functions nested inside of workflow functions

## 4.0.1-beta.5

### Patch Changes

- 4f9ae4e: Remove step transformation in client mode

## 4.0.1-beta.4

### Patch Changes

- e0c6618: Specify import path of `start` function on error in SWC plugin

## 4.0.1-beta.3

### Patch Changes

- 4a821fc: Fix Windows path handling by normalizing backslashes to forward slashes in workflow IDs
- 4a821fc: Fix building SWC plugin on Windows

## 4.0.1-beta.2

### Patch Changes

- f973954: Update license to Apache 2.0

## 4.0.1-beta.1

### Patch Changes

- 1408293: Add "description" field to `package.json` file
- e46294f: Add "license" and "repository" fields to `package.json` file

## 4.0.1-beta.0

### Patch Changes

- fcf63d0: Initial publish
