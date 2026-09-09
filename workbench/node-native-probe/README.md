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
explicit migration, reopen behavior, and a provisional structured error
envelope. It also starts a Rust-owned queue supervisor with an explicitly
injected loopback flow URL and checks HTTP failure retry, `timeoutSeconds`
rescheduling, stable message identity, acknowledgement, and bounded shutdown
during a stalled callback.

`AsyncTask` currently uses Node's shared libuv worker pool and opens a
connection per operation. The worker prototype uses one dedicated blocking
thread, concurrency one, loopback HTTP only, and bounded socket timeouts. Those
are probe constraints, not the final connection-pool, executor, HTTP client,
authentication, or concurrency topology. It is not yet a complete `World`,
package layout, release matrix, queue policy, stream, or cancellation design.
The local development path has been exercised on macOS arm64; the dedicated CI
workflow is the cross-platform verification matrix.
