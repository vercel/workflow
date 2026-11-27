# @workflow/swc-plugin

SWC transform plugin to transform the directives for [Workflow SDK](https://workflow-sdk.dev).

## Builds

An SWC plugin only loads on the `@swc/core` line its `swc_core` was built for, so the package ships two builds of the same plugin:

| Export | File | Runs on |
| --- | --- | --- |
| `@workflow/swc-plugin` | `swc_plugin_workflow.wasm` | `@swc/core` 1.15.x |
| `@workflow/swc-plugin/swc-1.16` | `swc_plugin_workflow_swc116.wasm` | `@swc/core` 1.16.x |

Both are built from the same source (`src/` and `transform/src/`). `transform-swc-1.16/` and `swc-1.16/` are the Cargo packages that compile it against the newer `swc_core`; `transform/src/compat.rs` holds the few places where the two `swc_core` APIs differ. `pnpm build` builds both, and `pnpm test` runs the Rust tests against both and checks, in `test/builds.test.mjs`, that each build loads on its own `@swc/core` line and that both print the same code.

## Development

[Install rust](https://www.rust-lang.org/tools/install)

Add build target using rustup

```bash
rustup target add wasm32-unknown-unknown
```

Ensure you can test/build

```bash
cargo test
cargo check
cargo build
```
