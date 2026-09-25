/-
AttestSound: is the executorSpecVersion that #4366 attests on run_started
always <= what the executing core can actually read?

The #1044 raise trusts the attestation completely (it raises the persisted
run to it), and the #4193 force-claim gate then trusts the persisted value
(spec >= 8 => the victim understands hook_disposed{forceClaimedBy}). So the
whole chain is only sound if  attest <= coreMax  for the process that sent
the attestation.

Code facts (workflow origin/main + origin/peter/executor-spec-version):
* mintedSpecVersion(env = process.env) re-reads WORKFLOW_SEALED_LOG on every
  call: sealed ? SPEC_VERSION_CURRENT : SPEC_VERSION_SUPPORTS_SLOT_IDENTITY (6)
  (packages/world/src/spec-version.ts:146-152).
* world-vercel captures it ONCE as world.specVersion at createWorld
  (packages/world-vercel/src/index.ts:42).
* core refuses any World whose declared specVersion is outside
  [6, core's SPEC_VERSION_MAX_SUPPORTED] (runtime/world-compatibility.ts:37-56;
  called from getWorld/getWorldLazy/start).  core's MAX comes from core's copy
  of @workflow/world, mintedSpecVersion from world-vercel's copy: the two can
  differ when the packages are mixed (pinned separately, or bundled twice).
* #4366 attests  mintedSpecVersion()  re-evaluated per request
  (world-vercel/src/events.ts:765-770), NOT world.specVersion.
-/

inductive Source | recompute | captured
  deriving DecidableEq, Repr

/-- mint as computed by the World package whose SPEC_VERSION_CURRENT is `cur`. -/
def mint (cur : Nat) (sealed : Bool) : Nat := if sealed then cur else 6

/-- World declared version at createWorld (env at creation). -/
def declared (cur : Nat) (envCreate : Bool) : Nat := mint cur envCreate

/-- The compatibility check core runs before it will execute anything. -/
def accepted (cur coreMax : Nat) (envCreate : Bool) : Bool :=
  6 ≤ declared cur envCreate && declared cur envCreate ≤ coreMax

def attest (src : Source) (cur : Nat) (envCreate envCall : Bool) : Nat :=
  match src with
  | .recompute => mint cur envCall
  | .captured  => declared cur envCreate

def sound (src : Source) (cur coreMax : Nat) (envCreate envCall : Bool) : Bool :=
  !accepted cur coreMax envCreate || attest src cur envCreate envCall ≤ coreMax

/-- Domain: World package CURRENT in {6,7,8} (a World package minting 6 by
default does not exist, but keep it), core MAX in {6,7,8}. -/
def curs : List Nat := [6, 7, 8]
def maxes : List Nat := [6, 7, 8]
def bools : List Bool := [false, true]

def allSound (src : Source) (envFrozen : Bool) : Bool :=
  curs.all fun c => maxes.all fun m => bools.all fun e0 => bools.all fun e1 =>
    (envFrozen && e0 != e1) || sound src c m e0 e1

/-- #4366 as written is sound whenever the environment is frozen for the
life of the process (true on Vercel: env is per deployment). -/
theorem recompute_sound_env_frozen : allSound .recompute true = true := by decide

/-- Capturing world.specVersion is sound unconditionally. -/
theorem captured_sound_always : allSound .captured false = true := by decide

/-- #4366 as written is NOT sound if process.env can change after createWorld. -/
theorem recompute_unsound_env_mutable : allSound .recompute false = false := by decide

/-- Exact characterization of the unsound cases. -/
theorem recompute_unsound_iff :
    curs.all (fun c => maxes.all fun m => bools.all fun e0 => bools.all fun e1 =>
      (sound .recompute c m e0 e1 = false) ==
        (e0 == false && e1 == true && decide (c > m))) = true := by decide

/-- Concrete witness: core @ #4327 head (MAX 7) paired with world-vercel from
main (CURRENT 8) started with WORKFLOW_SEALED_LOG=0 (declares 6, accepted),
env flipped on in-process: attests 8 > 7, #1044 raises the run to 8 and the
force-claim gate would take a hook from a reader that cannot see
forceClaimedBy. -/
theorem witness : accepted 8 7 false = true ∧ attest .recompute 8 false true = 8 := by decide

/-- Kill switch direction is harmless: flipping sealed OFF in-process only
lowers the attestation (6), which the raise treats as not-newer or a lower
raise; never above coreMax. -/
theorem kill_switch_off_midprocess_sound :
    curs.all (fun c => maxes.all fun m =>
      sound .recompute c m true false) = true := by decide

#eval (curs.flatMap fun c => maxes.flatMap fun m => bools.flatMap fun e0 =>
  bools.filterMap fun e1 =>
    if sound .recompute c m e0 e1 then none
    else some s!"UNSOUND recompute: worldCURRENT={c} coreMAX={m} sealedAtCreate={e0} sealedAtCall={e1} attests {attest .recompute c e0 e1}")
