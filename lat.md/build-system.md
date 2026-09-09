# Build System

The build system turns semantic directives into separate host and workflow programs, stable identifiers, a manifest, and framework-specific route artifacts.

## Why Directives

`"use workflow"` and `"use step"` mark an execution boundary in syntax the compiler, editor tooling, runtime, and developer can all recognize.

A runtime-only wrapper cannot reliably prevent untracked side effects, extract closures, validate imports, or produce different host and sandbox bundles. Directives retain ordinary async/await control flow while making the changed semantics explicit at function or module scope.

The directives must be leading string directives. Module directives apply to exported async functions; function directives apply to that function. The SWC specification in `packages/swc-plugin-workflow/spec.md` is authoritative for supported syntax and transforms.

## Discovery

Discovery combines a fast textual pre-scan with an authoritative SWC detect transform.

The pre-scan cheaply narrows candidate files. Detect mode walks the AST without rewriting code and emits manifest metadata for workflows, steps, and classes with custom serialization. This two-stage design avoids parsing an entire dependency graph while rejecting false positives such as strings that merely resemble directives.

Dependency discovery is enabled by default for packages that expose workflow-related code. It can be disabled when an application's dependency graph should not contribute definitions, but the SDK's built-in serialization registrations remain seeded.

## Transform Modes

The same source is transformed in distinct modes because orchestration and side effects execute in different environments.

| Mode | Preserved bodies | Replaced bodies | Result |
| --- | --- | --- | --- |
| Step | step functions | workflow functions become direct-call errors | Host-executable steps registered by stable ID; workflow values carry IDs for `start()` |
| Workflow | workflow functions | step functions become durable proxies | Deterministic orchestration bundle for VM execution |
| Detect | all source unchanged | none | Manifest-only discovery output |

Step mode registers functions through a global symbol so transformed modules do not need injected imports. Workflow mode registers orchestrators and calls host-installed global hooks for steps and other primitives.

## Stable Definition IDs

Compiler-generated IDs have the form `{kind}//{module identity}//{function or class path}`.

Project code uses extension-free relative paths. Package code can use a versioned import specifier, which keeps identities consistent across export conditions and different physical copies of a dependency. Nested functions, object properties, and class methods extend the function path instead of relying on unstable generated variable names.

ID collisions are build errors. Manifests are sorted before writing so concurrent discovery does not make otherwise identical builds byte-different.

## Closures and Custom Classes

The transform makes values crossing the workflow/step boundary explicit and serializable.

Nested steps are hoisted for the host bundle. Captured local values are collected in workflow mode and recovered from step context in the host; module imports and module-level declarations remain ordinary bundle dependencies rather than serialized closure values.

Classes using `WORKFLOW_SERIALIZE` and `WORKFLOW_DESERIALIZE` receive stable class IDs and registrations in every relevant bundle. Their serializer and reviver execute under workflow constraints, so they must be deterministic data transformations.

## Generated Artifacts

Builders produce one deployable flow handler from a step-registration bundle and an embedded workflow VM bundle, plus manifests and webhook support.

The combined flow handler imports the step bundle for registration side effects and embeds the workflow bundle as code. It exports Web `Request` handlers for the well-known flow route and installs the queue trigger used for both orchestration and background steps.

The manifest maps source definitions to generated IDs and can be exposed publicly only when explicitly configured. Diagnostic artifacts and source maps are configurable because readable stack traces trade off against bundle size.

## Framework Integration

Framework packages adapt artifact placement, loader hooks, watch behavior, externals, and route registration without redefining runtime semantics.

`@workflow/builders` contains common discovery and esbuild/SWC orchestration. Next.js supplies its config wrapper and generated app routes. Rollup/Vite-family adapters install transforms and virtual handlers. Nitro covers local output and Vercel Build Output variations; Nuxt delegates to Nitro. Astro, SvelteKit, and Nest integrate their own build lifecycle.

Every adapter must produce behavior compatible with the same [[architecture#Request and Queue Boundary]]. Differences in framework module graphs are especially important for serialization-class registration and the no-mutable-module-state rule.

## Workflow Export Condition

Packages may expose a `workflow` export condition to provide sandbox-safe implementations distinct from their ordinary Node.js exports.

Workflow bundles resolve this condition and bundle their full dependency graph because the VM has no general `require()`. Host application code resolves normal Node/default exports. The top-level `workflow` package uses this split so host initialization stays out of sandboxed code.

## Build Correctness

The compiler and generated manifest form a protocol with the runtime, so transform changes require broader verification than a local snapshot update.

Changes should preserve registration in all bundle layers, stable IDs across symlinks and export conditions, source-map behavior, tree shaking, and framework watch rebuilds. Any SWC behavior change must update the plugin specification and should be exercised through builder and integration tests described in [[testing#Compiler and Integration Tests]].
