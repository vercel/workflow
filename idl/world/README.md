# World IDL (proposal)

A Smithy model of the World port, plus the TypeScript and Python interfaces
generated from it.

This is a proposal artifact. Nothing here is wired into the SDK, published, or
built by CI: no package depends on it, and no implementation is expected to
satisfy it yet. It exists so the shape of a single cross-language World
contract can be reviewed as code rather than as prose.

## What is here

| Path | Contents |
| --- | --- |
| `model/` | The Smithy model. Hand-written; the source of truth. |
| `generated/typescript/models`, `generated/typescript/schemas`, `generated/typescript/enums.ts` | Data types emitted by `smithy-typescript` in types mode. |
| `generated/typescript/ports.ts` | One TypeScript interface per service, emitted by `scripts/generate_ports.py`. |
| `generated/python/workflow_world/` | Python dataclasses, enums, errors, and `Protocol` interfaces, emitted by `scripts/generate_ports.py`. |
| `scripts/generate.sh` | Regenerates everything under `generated/`. |

## Deliberately absent: transports

No protocol trait, HTTP binding, or wire format appears anywhere in the model.
The operations are plain typed function shapes, so an in-process
implementation satisfies the generated interface directly, with no
serialization involved.

Adding HTTP or WebSocket later is an additive projection: an overlay model
applies protocol and binding traits on top of these same operations. That
choice is what the model is arranged to keep open, and none of it is proposed
here.

## Services

The surface is split into four service closures rather than one, because
Smithy services have no optional operations and today's `World` very much
does.

- **`WorldCore`** — the required surface: runs, steps, events, hooks, streams,
  queue send, deployment identity, and capability discovery. Every
  implementation provides all of it.
- **`WorldBatch`** — optional optimizations (`BatchGetRuns`,
  `BulkCancelRuns`, `WriteStreamChunks`). Callers fall back to the `WorldCore`
  equivalents when an implementation omits it.
- **`WorldConsumer`** — the reverse direction: the runtime implements
  `DeliverQueueMessage`, and a World's queue adapter calls it. Today's
  `createQueueHandler` becomes the thin per-language adapter that exposes it.
- **`WorldLocalHooks`** — operations resolved in-process that must never be
  exposed over a transport, marked with the `localOnly` trait. Encryption-key
  resolution lives here: it is modeled so TypeScript and Python share one
  contract, and it is the clearest example of an operation a transport
  projection must drop.

`GetWorldInfo` reports the spec version and capabilities. Feature detection by
method presence stops working the moment calls cross a transport, where every
method always exists.

## Modeling notes worth reviewing

- **Payloads stay opaque.** Run, step, hook, and event payloads are `blob`.
  They are produced by the SDK serialization pipeline and may be compressed or
  encrypted; the World never interprets them. Spec-version-1 runs carried
  unserialized JSON and are not representable — those need a conversion
  adapter.
- **`resolveData` cannot change an output type.** Smithy cannot vary a shape
  by an input value, so payload members are optional and `NONE` leaves them
  absent.
- **Event writes stay atomic.** `CreateEvent` returns the committed event, the
  entity it materialized, `stepCreated`, `maxEvents`, and the optional
  inline-delta members, because callers depend on all of it.
- **Slot contention is not an error.** A stale `eventCount` is not a
  precondition failure: a slot-numbering implementation bumps to the next free
  slot, commits, and reports the skipped events. `PreconditionFailedError` is
  reserved for the separate `preconditionGuard` capability.
- **Bulk cancel reports outcomes, not errors.** Missing, already-cancelled,
  and non-cancellable runs are per-run result variants, so one bad ID never
  fails the batch.
- **Hook token collisions stay events.** `hook_conflict` is readable but not
  creatable, matching the current contract.
- **Unions use empty structures, not `Unit`.** Variants like
  `BulkCancelOutcome$cancelled` can gain members later without a breaking
  change (and `Unit` members currently generate uncompilable TypeScript).
- **Queue payloads are opaque for now.** The invoke and health-check schemas
  are private to producer and consumer and versioned by run spec version;
  modeling them belongs with the transport work.
- **Analytics is not modeled yet.** It has different consistency, retention,
  and plan semantics, and belongs in its own service closure.

## Regenerating

```bash
# Smithy CLI: https://smithy.io/2.0/guides/smithy-cli/cli_installation.html
idl/world/scripts/generate.sh
```

`smithy build` resolves `software.amazon.smithy.typescript:smithy-typescript-codegen`
from Maven Central, so the first run needs network access. `build/` is
ignored; only `generated/` is committed.

## Why the Python interface is emitted locally

`smithy-typescript` covers TypeScript data types, and its types mode is
transport-free — exactly what this model wants. It stops there, though: types
mode emits data shapes only and never declares the operations, so nothing
upstream produces the per-service interface.

`smithy-python` has no published release and no Maven Central artifact at all,
so for Python there is nothing upstream to run.

`scripts/generate_ports.py` closes both gaps by reading the built model JSON:
it emits the TypeScript port interfaces on top of the generated types, and the
whole Python package. It is deliberately small and mechanical — the model
stays the source of truth, and the emitter is expected to be replaced by
`smithy-python` once that ships, and by a Smithy TypeScript integration if the
port interfaces should come from the same plugin as the types.

## Verification performed

- `smithy build` validates the model (1190 shapes) and generates the
  TypeScript types.
- The generated TypeScript, including `ports.ts`, type-checks under
  `tsc --strict` against `@smithy/types` and `@smithy/core`.
- The generated Python package imports, and its dataclasses, enums, and
  tagged-union variants round-trip in a smoke script.
