/**
 * VM/step-bundle stub for `@workflow/core/runtime/world-init`.
 *
 * Resolved via the `workflow` export condition. Empty by design — the host
 * is responsible for loading `world.ts` and populating the globalThis
 * world cache before any VM or step code executes. Including this module
 * (rather than letting the resolver fall through to the host file) keeps
 * `world.ts` and its server-only deps (`@workflow/world-vercel`,
 * `@workflow/world-local`, `cbor-x`, …) out of the workflow sandbox.
 *
 * See `../runtime/world-init.ts` for the host-side implementation and the
 * full rationale.
 */

export {};
