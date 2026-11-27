# Rust

Rust code shares one Cargo workspace. This directory covers the Rust World crates and bindings: conventions already in use, the plan for remaining work, and one document per implemented component.

- [[plan]] — Plan and readiness for Rust SQLite, Vercel and Postgres Worlds; retire it once its decisions are resolved.
- [[world-sqlite]] — Implemented Rust SQLite World: crate, Node binding, host probe and differences from the TS local World.

## Workspace

The root [[Cargo.toml]] lists every crate as a workspace member and shares package metadata, including edition 2024 and the minimum Rust version 1.87.

Members inherit `version`, `edition`, `license`, `publish` and `rust-version` from the workspace. Dependency versions must build on that minimum Rust version; [[crates/world-sqlite/Cargo.toml]] records why it holds rusqlite below a newer release. CI installs the stable toolchain, so it does not verify the minimum version.

The SWC compiler plugin in [[packages/swc-plugin-workflow/]] predates the layout below and keeps its own structure.

## Crate layout

Rust World components separate host-independent libraries from host bindings, following the direction in [[plan#Decisions before scaffolding]].

A pure Rust library lives in `crates/<name>/` as crate `workflow-<name>`, with no Node or binding-runtime dependency; [[crates/world-sqlite/]] is the first. Its Node binding lives in `packages/<name>-rust/` as crate `workflow-<name>-node`, built by napi-rs into the private npm package `@workflow/<name>-rust`, as in [[packages/world-sqlite-rust/]].

A binding package's `build` script runs `napi build --platform --esm -- --locked`. The generated loader, type declarations and native artifacts are ignored by Git, and Turbo does not cache the build. The build task declares `RUSTUP_HOME` and `CARGO_HOME`, as the SWC plugin's does, because Turbo's strict environment mode otherwise hides a relocated toolchain such as the one on Vercel's build image.

## Tests

Each crate carries its own tests, and each binding package also tests end to end through its host.

Unit tests sit inline in the module they cover, as `#[cfg(test)] mod tests`, and are limited to behavior the public API cannot observe. Functional tests in `crates/<name>/tests/` use only the public API; Cargo runs each file as a separate process.

A binding package's `test` script runs its crate's `cargo test --locked` first, then builds the addon and runs vitest. CI's unit job installs Rust and runs `pnpm turbo test` on Linux and Windows, which reaches both layers through that script, as it reaches the SWC plugin's `cargo test`.
