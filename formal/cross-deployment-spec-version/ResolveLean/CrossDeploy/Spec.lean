/-!
# CrossDeploy.Spec — the spec-version lattice shared by every model in ResolveLean

Everything here is a pure restatement of constants and predicates; no proofs.

| Lean                          | Code                                                                                   |
|-------------------------------|----------------------------------------------------------------------------------------|
| spec numbers 1..8 (literals)  | workflow origin/main packages/world/src/spec-version.ts:24-94 (LEGACY=1 .. HOOK_FORCE_CLAIM=8); workflow-server d0575db lib/version-utils.ts:49-102 (SLOT_IDENTITY=6, SEALED_LOG=7, HOOK_FORCE_CLAIM=8) |
| `usesSlotIdentity v`          | workflow-server lib/version-utils.ts:138-139 (`v >= 6`)                                 |
| `usesSealedLog v`             | workflow-server lib/version-utils.ts:157-158 (`v >= 7`)                                 |
| `understandsForcedHookDisposal v` | workflow-server lib/version-utils.ts:166-167 (`v >= 8`), force-claim gate events.ts:6050-6100 |
| `idKindFor v`                 | workflow-server lib/data/event-slot-identity.ts:143-160 `resolveEventId`: ULID below 6, slot (run_created pinned to slot 1) at >= 6 |
| `Status`                      | run status; terminal = completed/failed/cancelled (`isTerminalState`, run-spec-version-upgrade.ts:97) |
| `mintedSpecVersion` values    | origin/main spec-version.ts:170-176: 8, or 6 with WORKFLOW_SEALED_LOG=0 (never 7); #4327 head (764eafd1a): 7 or 6 |

Constants are written as literals in the definitions (omega cannot see through
`def` constants), with the name in a comment.
-/
namespace CrossDeploy

/-- Run status as the backend sees it. `terminal` stands for completed/failed/cancelled. -/
inductive Status where
  | pending
  | running
  | terminal
deriving DecidableEq, Repr

/-- Shape of an event id. `slot` = slot-numbered (spec >= 6), `ulid` = time-ordered ULID. -/
inductive IdKind where
  | ulid
  | slot
deriving DecidableEq, Repr

/-- `v >= SPEC_VERSION_SLOT_IDENTITY (6)`; version-utils.ts:138-139. -/
def usesSlotIdentity (v : Nat) : Bool := decide (6 ≤ v)

/-- `v >= SPEC_VERSION_SEALED_LOG (7)`; version-utils.ts:157-158. -/
def usesSealedLog (v : Nat) : Bool := decide (7 ≤ v)

/-- `v >= SPEC_VERSION_HOOK_FORCE_CLAIM (8)`; version-utils.ts:166-167. -/
def understandsForcedHookDisposal (v : Nat) : Bool := decide (8 ≤ v)

/-- Id mode the backend uses for events of a run whose held spec is `v`
(`resolveEventId`, event-slot-identity.ts:143-160; called with the request's run
object at events.ts:8280). -/
def idKindFor (v : Nat) : IdKind := if 6 ≤ v then .slot else .ulid

theorem idKindFor_slot {v : Nat} : idKindFor v = .slot ↔ 6 ≤ v := by
  unfold idKindFor; split <;> simp_all <;> omega

end CrossDeploy
