# Node native World probe

This private workbench proves one narrow integration path: Node.js calls the
Rust SQLite implementation through Node-API and executes the shared resilient
run-start contract fixture.

Run it explicitly from the repository root:

```bash
pnpm --filter @workflow/example-node-native-probe probe
```

It requires a repository-supported Node.js version, Rust 1.88 or newer, and
the platform C/linker toolchain. The build uses Cargo directly, and all Rust
dependencies are fixed by the root `Cargo.lock`.

The probe is intentionally outside the normal `build` and `test` task graph.
Its explicit command does not add native tooling to the normal pnpm install
graph.
It validates an ESM loader, off-thread SQLite calls, owned byte buffers,
explicit migration, a draining JavaScript `close()`, reopen behavior, and a
provisional structured error envelope. `AsyncTask` currently uses Node's
shared libuv worker pool and opens a connection per operation; that is a probe,
not the final connection-pool, executor, or queue-worker topology. It is not
yet a complete `World`, package layout, release matrix, queue, stream, or
cancellation design. The local development path has been exercised on macOS
arm64; the dedicated CI workflow is the cross-platform verification matrix.
