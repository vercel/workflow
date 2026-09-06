# Python native World probe

This private workbench proves one narrow integration path: Python calls the
Rust SQLite implementation through PyO3 and executes the shared resilient
run-start contract fixture.

Run it explicitly from the repository root:

```bash
python3 workbench/python-native-probe/build_native.py
python3 workbench/python-native-probe/probe.py
```

It requires Python 3.9 or newer, Rust 1.88 or newer, and the platform C/linker
toolchain. The build uses Cargo directly, and all Rust dependencies are fixed
by the root `Cargo.lock`.

The probe is intentionally outside the normal build and test task graph. It
validates a Python extension loader, awaitable off-thread SQLite calls, GIL
release, owned byte buffers, explicit migration, an async context manager and
draining `close()`, reopen behavior, panic containment, and a provisional
structured error envelope. The adapter currently uses Python's default
`asyncio` thread executor and opens a connection per operation; that is a
probe, not the final executor, connection-pool, or queue-worker topology. It is
not yet a complete `World`, wheel/package layout, release matrix, queue,
stream, or cancellation design. The dedicated CI workflow exercises the probe
on Linux, macOS, and Windows.
