# Why `vi.mock()` doesn't work in workflow integration tests

## Summary

`vi.mock()` cannot intercept imports inside step functions when using the `workflow()` Vitest plugin. This applies to both first-party code (your own modules) and third-party npm packages. Step dependencies are inlined into a pre-built bundle at build time, completely bypassing Vitest's module system. To mock step dependencies, use unit tests instead.

**Confirmed:** A test in `test/mock.test.ts` verifies that mocking the `ms` npm package via `vi.mock('ms', ...)` does not take effect — the real `ms()` function is called inside the step, not the mock.

## Root causes

Three layers of isolation prevent `vi.mock()` from working:

### 1. Dependencies are inlined into the step bundle

The step bundle (`steps.mjs`) is built by esbuild with `bundle: true`. Even though `externalizeNonSteps: true` is set, user code imported by step files is inlined directly into the bundle.

This happens because the builder's enhanced-resolve (`packages/builders/src/swc-esbuild-plugin.ts`) silently falls back to bundling when it can't resolve `.js` → `.ts` imports. The `onResolve` hook's catch block (line 135) returns `null` on resolution failure, letting esbuild handle it — which bundles the file.

For example, if `workflows/notification.ts` (a step file) imports `../lib/email.ts`, the enhanced resolver tries to resolve `../lib/email.js` and fails (because the actual file is `email.ts`). The error is swallowed, esbuild resolves it via its own `resolveExtensions` config, and the dependency gets inlined.

### 2. Bundle bypasses Vitest's module system

`setupWorkflowTests` loads the step bundle via:

```typescript
const stepsModule = await import(/* @vite-ignore */ join(outDir, 'steps.mjs'));
```

The `@vite-ignore` comment tells Vite not to process this dynamic import. The module is loaded through Node.js's native module system, completely bypassing Vitest's transform pipeline and module registry. `vi.mock()` only intercepts imports that go through Vitest's module system.

### 3. Timing: setup runs before mocks take effect

`setupFiles` execute before test files. `vi.mock()` calls are hoisted to the top of the test file, but by that point the step bundle and all its dependencies have already been loaded by the setup file. Even if the first two issues were fixed, the mock would be registered too late.

## Why the architecture works this way

A single workflow file can contain both `"use workflow"` and `"use step"` functions. The SWC plugin processes each file in one mode:

- **client mode** (Vitest transform via `workflowTransformPlugin`): both workflow and step functions become stubs. Test files get function references with `.workflowId` for `start()`.
- **step mode** (esbuild bundle): step functions retain their real implementations and call `registerStepFunction()`. Workflow functions become stubs.
- **workflow mode** (esbuild bundle): workflow functions are bundled as code strings for the VM. Step functions become stubs.

The same source file must be compiled twice in different modes — once for the test file (client mode) and once for execution (step mode). This requires separate build artifacts that can't share Vitest's module graph.

## What would need to change

To enable `vi.mock()` for step dependencies, three things need to change:

### Fix 1: Proper externalization of user code

**File:** `packages/builders/src/swc-esbuild-plugin.ts`

The enhanced-resolve silently swallows errors for `.js` → `.ts` resolution. Fix the `onResolve` hook's catch block to retry with TypeScript extensions, or configure enhanced-resolve with `extensionAlias` mapping `.js` → `[.ts, .tsx, .js]`. This would keep user imports as `import` statements in the output instead of inlining them.

### Fix 2: Load step bundle through Vitest's module system

**File:** `packages/vitest/src/index.ts`

Remove `@vite-ignore` from the step bundle import so Vitest processes it and can intercept module resolution. This may require registering the steps.mjs path as a Vitest alias so the dynamic import path resolves through Vitest's pipeline.

### Fix 3: Defer step bundle loading

**File:** `packages/vitest/src/index.ts`

Move step bundle loading from `setupFiles` (which runs before test files) to lazy initialization on first step invocation. This way, `vi.mock()` from the test file will have already been registered when the step bundle and its dependencies are first imported.

The workflow bundle does **not** need these changes — it runs inside a sandboxed VM where module mocking is architecturally impossible, and workflow functions should not have side effects that need mocking.

## Workarounds

Until these changes are made:

1. **Unit test steps directly** — Import step functions without the workflow plugin. `vi.mock()` works normally since there's no pre-built bundle. `"use step"` is a no-op without the compiler.
2. **Dependency injection** — Pass dependencies as step arguments instead of importing them at the module level.
3. **Hook-based patterns** — Use hooks to inject test data into the workflow at runtime, rather than mocking the source of that data.
