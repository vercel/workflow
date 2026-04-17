# @workflow/swc-plugin

## 5.0.0-beta.2

### Patch Changes

- [#1743](https://github.com/vercel/workflow/pull/1743) [`136bd35`](https://github.com/vercel/workflow/commit/136bd35a98a40a5dc55b2fbf838924c0af001ba7) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Preserve original step function names in stack traces by setting `Object.defineProperty(fn, "name", ...)` in the IIFE registration

- [#1759](https://github.com/vercel/workflow/pull/1759) [`173756d`](https://github.com/vercel/workflow/commit/173756dc4d097fd90432e2c38c91ce1b959a6352) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Rename `useworkflow.dev` URLs to `workflow-sdk.dev`

## 5.0.0-beta.1

### Major Changes

- [#1632](https://github.com/vercel/workflow/pull/1632) [`0a86de3`](https://github.com/vercel/workflow/commit/0a86de3afd1b51efff32e1c3cefd7f384d1b2d8d) Thanks [@TooTallNate](https://github.com/TooTallNate)! - **BREAKING CHANGE**: Inline all step registrations as self-contained IIFEs instead of generating `import { registerStepFunction } from "workflow/internal/private"`. Closure variable access is also inlined. This eliminates the dependency on the `workflow` package being available in `node_modules`, enabling 3rd-party packages to define step functions. Registrations are now placed immediately after each function definition instead of being batched at the bottom of the file.

### Minor Changes

- [#1633](https://github.com/vercel/workflow/pull/1633) [`d040182`](https://github.com/vercel/workflow/commit/d0401829320c2880a0a5c2404ed9dede94eb17a0) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Allow synchronous functions to use `"use step"` directive. This enables using `"use step"` as a mechanism to strip Node.js-dependent code from the workflow VM bundle without requiring the function to be async.

### Patch Changes

- [#1671](https://github.com/vercel/workflow/pull/1671) [`66585fd`](https://github.com/vercel/workflow/commit/66585fd46723604a632d08b6c973d5a95582b1af) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Eliminate unreferenced private class members in workflow mode after `"use step"` stripping

- [#1664](https://github.com/vercel/workflow/pull/1664) [`ebb0a4a`](https://github.com/vercel/workflow/commit/ebb0a4a4e366eb1be1d385bf1eedbbe27371c9a9) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Restore export validation for file-level `"use step"` files: only function exports (sync or async) are allowed; non-function exports (constants, classes, re-exports) emit an error

## 5.0.0-beta.0

### Major Changes

- [#1642](https://github.com/vercel/workflow/pull/1642) [`c5cdfc0`](https://github.com/vercel/workflow/commit/c5cdfc00751c5bef36c4be748d819081b934fbcd) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Initial v5 beta release

### Patch Changes

- [#1641](https://github.com/vercel/workflow/pull/1641) [`35b539b`](https://github.com/vercel/workflow/commit/35b539b146015fd63ad71e0d08614de96d34aa45) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `detect` mode to SWC plugin and use it during discovery to filter false positive directive detections

- [#1630](https://github.com/vercel/workflow/pull/1630) [`bab8cdd`](https://github.com/vercel/workflow/commit/bab8cddf98e1d4ca897fbfc9cc1fb51a3333c695) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Support getter functions with `"use step"` directive

## 4.1.0-beta.22

### Patch Changes

- [#1599](https://github.com/vercel/workflow/pull/1599) [`5d22e61`](https://github.com/vercel/workflow/commit/5d22e61446d5146887f8c268d305ea42e3f67b09) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix class expression method registrations to use binding name instead of internal class name, preventing `ReferenceError` at runtime for pre-bundled packages

- [#1601](https://github.com/vercel/workflow/pull/1601) [`7c996a7`](https://github.com/vercel/workflow/commit/7c996a76c59cb88fa58d15942218b308d1cd100f) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Rewrite anonymous `export default class` to a `const` declaration so the class has an accessible binding name for serde/step registration code

## 4.1.0-beta.21

### Patch Changes

- [#1503](https://github.com/vercel/workflow/pull/1503) [`77fd9ad`](https://github.com/vercel/workflow/commit/77fd9ad3556544a0efd7d6c4d00eedfc03dc10e5) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Inline class serialization registration instead of importing from `workflow/internal/class-serialization`. This eliminates the dependency on the `workflow` package in SWC-generated code, enabling 3rd-party packages (like `@vercel/sandbox`) to define serializable classes without needing `workflow` as a dependency.

- [#1144](https://github.com/vercel/workflow/pull/1144) [`992d768`](https://github.com/vercel/workflow/commit/992d768f8026846bc2587892fc06e998d8c1fd8e) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add class registration detection for CommonJS syntax

## 4.1.0-beta.20

### Patch Changes

- [#1368](https://github.com/vercel/workflow/pull/1368) [`5d95abf`](https://github.com/vercel/workflow/commit/5d95abf9413462e82759bf68ab985e794ce05756) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix closure variable detection for `new` expressions, exclude module-level declarations from being over-captured, preserve original step function bodies in enclosing functions for direct calls, and walk into nested function/method bodies to detect deeply nested closure variable usage

## 4.1.0-beta.19

### Patch Changes

- [#1312](https://github.com/vercel/workflow/pull/1312) [`d72c822`](https://github.com/vercel/workflow/commit/d72c82220f0c56bb26edbc918e485b8bd14c959b) Thanks [@NathanColosimo](https://github.com/NathanColosimo)! - Fix bug where the SWC compiler bug prunes step-only imports in the client-mode transformation

## 4.1.0-beta.18

### Patch Changes

- [#991](https://github.com/vercel/workflow/pull/991) [`054e40c`](https://github.com/vercel/workflow/commit/054e40c91be615809c71d3ad29573c78c4491825) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix anonymous class expression names for serialization classes

## 4.1.0-beta.17

### Patch Changes

- [#923](https://github.com/vercel/workflow/pull/923) [`ef23b0b`](https://github.com/vercel/workflow/commit/ef23b0be770bbb5ccca015fb2564953fe6a761d7) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix step functions nested multiple levels deep in an object

- [#924](https://github.com/vercel/workflow/pull/924) [`fcfaf8b`](https://github.com/vercel/workflow/commit/fcfaf8bbaa912b1767c646592e539d5f98cd1e9c) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Set `stepId` property on step functions in "client" mode for serialization support

## 4.1.0-beta.16

### Patch Changes

- [#901](https://github.com/vercel/workflow/pull/901) [`35a9f0c`](https://github.com/vercel/workflow/commit/35a9f0cb0360ffc48c8a8e7db3a299924ab48375) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix module specifier cache bug and add subpath export resolution for package IDs

- [#872](https://github.com/vercel/workflow/pull/872) [`b9c782d`](https://github.com/vercel/workflow/commit/b9c782d75f5452265764cd36d5e306060f8703c3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix class ID generation when class is bound to a variable

- [#874](https://github.com/vercel/workflow/pull/874) [`b5296a7`](https://github.com/vercel/workflow/commit/b5296a7a32b9037aa03c71d87e785fa2d5384a11) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add discovered serializable classes in all context modes

- [#777](https://github.com/vercel/workflow/pull/777) [`c1d7c8d`](https://github.com/vercel/workflow/commit/c1d7c8dbb44afb7434acb07fee500ecaa1224fb0) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add support for "use step" functions in class instance methods

- [#899](https://github.com/vercel/workflow/pull/899) [`73bf7be`](https://github.com/vercel/workflow/commit/73bf7be925a8ffc0c6fce0cc75b6092243882088) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Change compiler ID generation logic to use Node.js import specifiers

  IDs for workflows, steps, and classes now use module specifiers:
  - Local files use `./path/to/file` format instead of `path/to/file.ext`
  - Package files use `packageName@version` format (e.g., `workflow@4.0.1`)

  This enables stable IDs across different package.json export conditions.

- [#859](https://github.com/vercel/workflow/pull/859) [`8114792`](https://github.com/vercel/workflow/commit/8114792600a851fbf14cf41f8340e646aef36368) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add discovery for custom classes with workflow serialization

## 4.1.0-beta.15

### Minor Changes

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - **BREAKING**: Storage interface is now read-only; all mutations go through `events.create()`
  - Remove `cancel`, `pause`, `resume` from `runs`
  - Remove `create`, `update` from `runs`, `steps`, `hooks`
  - Add run lifecycle events: `run_created`, `run_started`, `run_completed`, `run_failed`, `run_cancelled`
  - Add `step_created` event type
  - Remove `fatal` field from `step_failed` (terminal failure is now implicit)
  - Add `step_retrying` event with error info for retriable failures

### Patch Changes

- [#866](https://github.com/vercel/workflow/pull/866) [`244b94a`](https://github.com/vercel/workflow/commit/244b94a0665087ece694ae881a17d6aaa0ca0a7f) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add support for top-level `using` declarations inside of step / workflow functions

- [#864](https://github.com/vercel/workflow/pull/864) [`81c5a83`](https://github.com/vercel/workflow/commit/81c5a835ae647cd94d88ccec8c3b037acdfb6598) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add "classes" object to `manifest.json` file

- [#860](https://github.com/vercel/workflow/pull/860) [`b4113da`](https://github.com/vercel/workflow/commit/b4113da9541f3cebf1605d753374025f95259bf8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Enable custom class serialization transformations for "client" mode

## 4.0.1-beta.14

### Patch Changes

- [#762](https://github.com/vercel/workflow/pull/762) [`1843704`](https://github.com/vercel/workflow/commit/1843704b83d5aaadcf1e4f5f1c73c150bd0bd2a3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add support for custom class instance serialization

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
