# 03 · Build-time errors — `WorkflowBuildError` class + node-module-in-workflow

## Scenario A: Node.js builtin used inside a workflow function

`workbench/example/workflows/1_simple.ts` patched to call
`readFileSync()` directly in the workflow body:

```ts
import { readFileSync } from 'node:fs';

export async function simple(i: number) {
  'use workflow';
  const data = readFileSync('/tmp/nope', 'utf8'); // ← Node.js in workflow ctx
  // …
}
```

## Actual build output

```
Using target: vercel-build-output-api
Building with VercelBuildOutputAPIBuilder
Creating Vercel Build Output API steps function
Discovering workflow directives 277ms
Created steps bundle 532ms
Creating Vercel Build Output API workflows function
✘ [ERROR] You are attempting to use "node:fs" which is a Node.js module. Node.js modules are not available in workflow functions.

Learn more: https://workflow-sdk.dev/err/node-js-module-in-workflow [plugin workflow-node-module-error]

    workflows/1_simple.ts:12:15:
      12 │   const data = readFileSync('/tmp/nope', 'utf8');
         │                ~~~~~~~~~~~~
         ╵                Move this function into a step function.

 ELIFECYCLE  Command failed with exit code 1.
```

What's good here:

- Clear cause: names the offending module (`node:fs`).
- Inline source-code pointer from esbuild.
- Actionable hint (`╵ Move this function into a step function.`).
- Docs link to a specific page
  (`https://workflow-sdk.dev/err/node-js-module-in-workflow`).

## Scenario B: `WorkflowBuildError` class

The PR adds `WorkflowBuildError` in `packages/errors/src/index.ts` and
wires it into user-facing build-time failures in `packages/builders/src/base-builder.ts`:

- Build-failed-during-phase errors (esbuild errors surfaced via
  `logEsbuildMessages` with `throwOnError: true`).
- "Failed to resolve built-in steps sources" (missing `workflow` install).
- "No output files generated from esbuild" (empty workflow directory /
  missing directives).

Each throws with a `hint:` pointing the user at the likely fix. See
`packages/errors/src/build-error.test.ts` for the unit-level coverage
and `.changeset/friendlier-build-errors.md` for the changeset entry.

## Follow-up noted during testing (out of scope)

`esbuild.context(...).rebuild()` throws directly when the build fails —
this bypasses the `logEsbuildMessages` → `WorkflowBuildError` path at
base-builder.ts:596 / 596+ for several call sites. The WorkflowBuildError
class is fully wired in the module but the throw-on-rebuild path makes
the class unreachable for a subset of errors (most commonly: unresolved
imports in step files). Wrapping the `rebuild()` calls in `try/catch →
logEsbuildMessages` is a small follow-up — not included here because it
touches every rebuild call site and deserves its own PR.

## Related changesets

- `.changeset/friendlier-build-errors.md` — `WorkflowBuildError` + hints
