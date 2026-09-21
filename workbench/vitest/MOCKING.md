# `vi.mock()` under the `workflow()` Vitest plugin

## Summary

Steps do not execute from your test file's module graph. They execute from the
bundles `buildWorkflowTests()` writes to `.workflow-vitest/`, and workflow
bodies execute from a code string inside the QuickJS VM. What `vi.mock()` can
reach follows from that:

| You mock                                                      | Step code sees the mock | Workflow body sees the mock |
| ------------------------------------------------------------- | ----------------------- | --------------------------- |
| an npm package imported by a step file                          | yes\*                   | no                          |
| an npm package imported by a local module a step file imports   | yes\*                   | no                          |
| a project-local module imported by a step file                  | no                      | no                          |
| a step function called directly, with no `workflow()` plugin    | yes (plain Vitest)      | n/a                         |

\* Only when the generated bundles are loaded through Vitest's module runner.
See [When the npm cases do not hold](#when-the-npm-cases-do-not-hold).

`test/mock.test.ts` pins every row.

## Why

### The build externalizes npm packages and inlines local modules

`buildWorkflowTests()` builds `.workflow-vitest/combined.mjs` (workflow
entrypoint plus step registrations) with esbuild. Project-local imports are
bundled inline on purpose: the output is loaded by Node, which cannot import a
raw `.ts` specifier (vercel/workflow#2289). npm packages stay as real `import`
statements in the bundle, and an npm import inside an inlined local module is
hoisted into the bundle's own imports.

So `workflows/utils.ts` disappears into the bundle — there is no module left
for `vi.mock("../workflows/utils.js")` to replace — while the `ms` it imports
is still resolved at runtime, and that resolution can be intercepted.

### The step registry is last-write-wins, and the bundle writes last

Both your test file (compiled in step mode by the plugin's transform) and the
generated bundle register step implementations in the same `globalThis` map,
keyed `Symbol.for("@workflow/core//registeredSteps")`. The bundle is imported
lazily on the first dispatch, after your test module has been evaluated, so its
registrations replace the ones the test graph installed. That is why step
behavior follows the bundle rather than the function you imported in the test.

### Workflow bodies have no module system

A `"use workflow"` body is compiled to a code string and evaluated in the
QuickJS VM. There is no module registry in there, so no mocking mechanism can
apply. It is also why the runtime rule is "side effects belong in steps": if
something needs mocking, it belongs in a step.

## When the npm cases do not hold

The bundle is loaded with a dynamic `import()` from inside `@workflow/vitest`.
Whether `vi.mock()` reaches it depends on how Vitest loaded the plugin itself:

- **Plugin processed by Vitest's module runner** — a workspace link (this
  workbench) or an explicit `server.deps.inline`. Vitest rewrites the dynamic
  import, the bundle resolves through Vitest, and mocks of its external imports
  apply.
- **Plugin loaded natively** — an ordinary `node_modules` install, where Vitest
  externalizes it. Node resolves the bundle's imports and the step gets the
  real package.

Verified by running this workbench's `test/mock.test.ts` from a `pnpm deploy`
copy, where `@workflow/vitest` sits in `node_modules` instead of being linked:
both npm-mock cases fail there and pass here.

An app that wants the behavior this workbench gets can ask for it:

```ts
// vitest.integration.config.ts
export default defineConfig({
  plugins: [workflow()],
  test: {
    server: { deps: { inline: [/@workflow\/vitest/] } },
  },
});
```

The cost is that the generated bundle goes through Vite's transform pipeline in
every worker. Until the plugin decides this for you, treat step-level mocking
as something to opt into rather than something to rely on.

## Patterns that work in any install

1. **Unit test the step directly.** Import the function without the
   `workflow()` plugin: `"use step"` is a no-op without the compiler, so it is
   an ordinary async function and `vi.mock()` behaves normally.
2. **Pass the dependency in.** A step that takes its collaborator as an
   argument is controlled by the caller, with no module interception involved.
3. **Feed data through hooks.** Use `createHook()` and resume it from the test
   with the values you want instead of mocking the source of those values.
