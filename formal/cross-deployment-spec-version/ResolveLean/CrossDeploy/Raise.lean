import CrossDeploy.Spec
/-!
# CrossDeploy.Raise — the backend raise decision (vercel/workflow-server#1044)

Pure model of `upgradeRunSpecVersion` (workflow-server d0575db
lib/data/run-spec-version-upgrade.ts:80-209). The function receives the run
object the request holds (`input`, possibly stale), the executor's attested
version `e` (#4366 @ 03e6e6771: `executorSpecVersion` = the World's specVersion
captured at createWorld, world-vercel events.ts:780 / index.ts:31-34), the strongly
consistent 2-event log head it reads, and — for the transaction — the run row as
it actually is when the transaction commits (`actual`).

| Lean                          | Code (run-spec-version-upgrade.ts)                                      |
|-------------------------------|-------------------------------------------------------------------------|
| `skip .notNewer`              | :96  `executorSpecVersion <= fromSpecVersion` (no read)                   |
| `skip .terminal`              | :97  `isTerminalState(run.status)` (no read)                              |
| `rekey`                       | :99-100 crossing 6 (`!usesSlotIdentity(from) && usesSlotIdentity(to)`)    |
| `requiresFreshLog`            | :101-103 rekey or crossing 7                                              |
| `skip .logNotFresh` (status)  | :107-109 fresh log needed but input status ≠ pending (no read)            |
| head read (`LogHead`)         | :111 `readLogHead()` = consistent ascending query limit 2 (events.ts:1627-1634) |
| `.empty`                      | :113 `run-created-not-committed`                                          |
| `.otherFirst`                 | :114-116 `run-created-not-first`                                          |
| `.runCreatedThenMore`         | :117 `requiresFreshLog && head.length > 1` -> `log-not-fresh`             |
| `.runCreatedOnly .slot` & rekey | :118-122 run_created already a slot -> `log-not-fresh`                  |
| `txCond`                      | :134-146 run patch `where specVersion == from AND (fresh ? status == pending : status ∉ terminal)` |
| rekey / patch of run_created  | :147-182 (delete ULID row + create slot-1 row, or patch its specVersion)  |
| `.upgraded`, run := reread    | :184-208 reread after success                                             |
| `.lostRace`, run := reread    | :186-196 cancelled transaction -> reread                                  |
| every `skip`, run := input    | :83-92 `skip()` returns the input `run` unchanged                         |
| `rereadOnSkip = true`         | PROPOSED FIX: post-read skips hand back the reread run (not in #1044)     |

Theorems (fully general):
* `upgrade_never_lowers`       : r' ≥ r, given the DB never lowers a run's spec between the input read and the reread
  (`hmono`). #1044 does NOT guarantee `hmono`: the v4 missing-run-event recovery deletes the run row and
  resilient start rebuilds it at the caller's stamp (v4/events.ts:1650-1830, events.ts:8056-8238), so a reread
  can see a lower spec (`upgrade_can_lower_without_hmono`; the whole-system check is `monotone` in StaleSkip)
* `upgrade_serial_mem`         : without concurrency (actual = input), r' ∈ {r, e}
* `upgrade_serial_no_lost_race`: without concurrency the transaction never loses
* `upgrade_crossing_requires_fresh` : a result that crosses 6 or 7 implies status pending (input and actual) and head = [run_created] (a ULID one when crossing 6)
* `upgrade_not_terminal`       : an upgrade only lands on a non-terminal run
* `upgrade_le_max`             : r' ≤ max r e under no concurrency (never above the attested version)
* `stale_skip_returns_stale`   : witness of the #1044 hazard — a post-read skip hands back a stale pending ULID-mode run while the real run is running at 8

Classification (#4366 @ 03e6e6771, `crossesStructuralSpecVersion`), fully general:
* `crossesStructural_false_iff` / `_true_iff` : false exactly when every version in (from, to] is capability-only {3,4,5,8}
* `crosses_listed_structural`, `crosses_unclassified_future` : crossing 2/6/7, or any v ≥ 9, counts
* `crossesStructural_split` : a structural move cannot be split into non-structural hops
* `capabilityOnly_move_preserves_layout` : a non-structural upward move keeps event sourcing, slot ids, id kind and sealed log
* `requiresFreshLog_structural` : #1044's fresh-log crossings are all structural; `classification_stricter_than_fresh`: the converse fails exactly on crossing 1/2 or ≥ 9 (e.g. 8→9)
* `capabilityOnly_moves` : the non-structural moves within 1..9 are 2→3,4,5; 3→4,5; 4→5; 7→8
-/
namespace CrossDeploy

structure Run where
  spec : Nat
  status : Status
deriving DecidableEq, Repr

/-- Shape of the first (at most) two events of the log in id order. -/
inductive LogHead where
  | empty
  | runCreatedOnly (k : IdKind)
  | runCreatedThenMore (k : IdKind)
  | otherFirst
deriving DecidableEq, Repr

inductive SkipReason where
  | notNewer
  | terminal
  | logNotFresh
  | runCreatedNotCommitted
  | runCreatedNotFirst
deriving DecidableEq, Repr

inductive Outcome where
  | upgraded (rekeyed : Bool)
  | skipped (r : SkipReason)
  | lostRace
deriving DecidableEq, Repr

structure Result where
  outcome : Outcome
  run : Run
deriving DecidableEq, Repr

def rekey (fromV toV : Nat) : Bool := !usesSlotIdentity fromV && usesSlotIdentity toV

def requiresFreshLog (fromV toV : Nat) : Bool :=
  rekey fromV toV || (!usesSealedLog fromV && usesSealedLog toV)

def isTerminal (s : Status) : Bool := s == .terminal

/-- Which run object the function hands back. -/
inductive Ret where
  /-- the caller's own (possibly stale) run: every `skip()` (:83-92) -/
  | input
  /-- the strongly consistent reread (:184-196), lost race or (fix) post-read skip -/
  | actual
  /-- the reread after a successful transaction: `actual` with `specVersion = e` -/
  | actualE
deriving DecidableEq, Repr

/-- The control flow of `upgradeRunSpecVersion` over the boolean facts it
branches on. Every `if` below is one line of run-spec-version-upgrade.ts:

* `notNewer`   = `executorSpecVersion <= fromSpecVersion`        (:96)
* `terminalIn` = `isTerminalState(run.status)` on the input       (:97)
* `rk`, `fr`   = rekey / requiresFreshLog                        (:99-103)
* `inPending`  = input `run.status === 'pending'`                 (:107)
* `head`       = consistent log head                             (:111-122)
* `specEq`, `actPending`, `actTerminal` = the transaction's run-row conditions (:134-146) -/
def upgradeAbs (rereadOnSkip notNewer terminalIn rk fr inPending : Bool) (head : LogHead)
    (specEq actPending actTerminal : Bool) : Outcome × Ret :=
  let afterRead := fun (r : SkipReason) => (Outcome.skipped r, if rereadOnSkip then Ret.actual else Ret.input)
  let tx : Outcome × Ret :=
    if specEq && (if fr then actPending else !actTerminal) then (.upgraded rk, .actualE)
    else (.lostRace, .actual)
  if notNewer then (.skipped .notNewer, .input)
  else if terminalIn then (.skipped .terminal, .input)
  else if fr && !inPending then (.skipped .logNotFresh, .input)
  else
    match head with
    | .empty => afterRead .runCreatedNotCommitted
    | .otherFirst => afterRead .runCreatedNotFirst
    | .runCreatedThenMore _ => if fr then afterRead .logNotFresh else tx
    | .runCreatedOnly k => if rk && k == .slot then afterRead .logNotFresh else tx

/-- `upgradeRunSpecVersion` (see the table above): `upgradeAbs` fed with the
facts computed from the run objects, and the chosen run object materialized. -/
def upgrade (rereadOnSkip : Bool) (input : Run) (e : Nat) (head : LogHead) (actual : Run) : Result :=
  let r := upgradeAbs rereadOnSkip (decide (e ≤ input.spec)) (isTerminal input.status)
    (rekey input.spec e) (requiresFreshLog input.spec e) (input.status == .pending) head
    (actual.spec == input.spec) (actual.status == .pending) (isTerminal actual.status)
  { outcome := r.1
    run := match r.2 with
      | .input => input
      | .actual => actual
      | .actualE => { actual with spec := e } }

/-- Rekey means crossing 6. -/
theorem rekey_iff (a b : Nat) : rekey a b = true ↔ a < 6 ∧ 6 ≤ b := by
  simp [rekey, usesSlotIdentity] <;> omega

theorem requiresFreshLog_iff (a b : Nat) :
    requiresFreshLog a b = true ↔ (a < 6 ∧ 6 ≤ b) ∨ (a < 7 ∧ 7 ≤ b) := by
  simp [requiresFreshLog, rekey, usesSlotIdentity, usesSealedLog] <;> omega

def allHeads : List LogHead :=
  [.empty, .otherFirst, .runCreatedThenMore .ulid, .runCreatedThenMore .slot,
   .runCreatedOnly .ulid, .runCreatedOnly .slot]

theorem mem_allHeads (h : LogHead) : h ∈ allHeads := by
  cases h with
  | runCreatedThenMore k => cases k <;> simp [allHeads]
  | runCreatedOnly k => cases k <;> simp [allHeads]
  | _ => simp [allHeads]

/-! ### Exhaustive facts about the control flow (decided over all 3072 inputs) -/

set_option synthInstance.maxHeartbeats 1000000
set_option synthInstance.maxSize 100000

/-- The attested version is handed back only after a transaction whose
conditions held; that requires "newer", a non-terminal input and a matching,
non-terminal row (given the row's status facts are consistent: a pending row
is not terminal); and a fresh-log crossing needs a pending input and row and a
head of exactly `[run_created]` (a ULID one when re-keying). -/
theorem abs_actualE : ∀ b nn ti rk fr ip, ∀ h ∈ allHeads, ∀ se ap at_,
    (ap = true → at_ = false) →
    (upgradeAbs b nn ti rk fr ip h se ap at_).2 = .actualE →
      nn = false ∧ ti = false ∧ se = true ∧ at_ = false ∧
      (upgradeAbs b nn ti rk fr ip h se ap at_).1 = .upgraded rk ∧
      (fr = true → ip = true ∧ ap = true ∧
        (h = .runCreatedOnly .ulid ∨ (h = .runCreatedOnly .slot ∧ rk = false))) := by
  decide

theorem abs_upgraded : ∀ b nn ti rk fr ip, ∀ h ∈ allHeads, ∀ se ap at_, ∀ x,
    (upgradeAbs b nn ti rk fr ip h se ap at_).1 = .upgraded x →
      (upgradeAbs b nn ti rk fr ip h se ap at_).2 = .actualE := by
  decide

/-- The reread is handed back only on a lost race or (with the fix) a post-read skip. -/
theorem abs_actual : ∀ b nn ti rk fr ip, ∀ h ∈ allHeads, ∀ se ap at_,
    (upgradeAbs b nn ti rk fr ip h se ap at_).2 = .actual →
      ((upgradeAbs b nn ti rk fr ip h se ap at_).1 = .lostRace ∨ b = true) := by
  decide

/-- Serial case (the row is the input): the transaction cannot lose, provided
the status facts are consistent (a pending run is not terminal). -/
theorem abs_serial : ∀ b nn ti rk fr ip, ∀ h ∈ allHeads,
    (ip = true → ti = false) →
      (upgradeAbs b nn ti rk fr ip h true ip ti).1 ≠ .lostRace := by
  decide

/-! ### General theorems about `upgrade` -/

theorem actPendingNotTerminal (r : Run) :
    (r.status == .pending) = true → isTerminal r.status = false := by
  cases h : r.status <;> simp [isTerminal]

/-- Never lowers. The reread (`actual`) is later than the input read and the DB
never lowers a run's spec (only this function writes it, and only upwards), so
`input.spec ≤ actual.spec` is the only assumption. -/
theorem upgrade_never_lowers (b : Bool) (input actual : Run) (e : Nat) (head : LogHead)
    (hmono : input.spec ≤ actual.spec) :
    input.spec ≤ (upgrade b input e head actual).run.spec := by
  unfold upgrade
  generalize hr : upgradeAbs b _ _ _ _ _ head _ _ _ = r
  rcases r with ⟨o, ret⟩
  cases ret with
  | input => simp
  | actual => simpa using hmono
  | actualE =>
    have := (abs_actualE _ _ _ _ _ _ head (mem_allHeads head) _ _ _ (actPendingNotTerminal actual) (by rw [hr])).1
    simp at this ⊢; omega

/-- Serial case (no concurrent writer): the result is the input or the attested version. -/
theorem upgrade_serial_mem (b : Bool) (r : Run) (e : Nat) (head : LogHead) :
    (upgrade b r e head r).run.spec = r.spec ∨ (upgrade b r e head r).run.spec = e := by
  unfold upgrade
  generalize upgradeAbs b _ _ _ _ _ head _ _ _ = x
  rcases x with ⟨o, ret⟩
  cases ret <;> simp

/-- Serial case: the transaction's conditions hold, so there is no lost race. -/
theorem upgrade_serial_no_lost_race (b : Bool) (r : Run) (e : Nat) (head : LogHead) :
    (upgrade b r e head r).outcome ≠ .lostRace := by
  unfold upgrade
  simp only [beq_self_eq_true]
  apply abs_serial _ _ _ _ _ _ head (mem_allHeads head)
  cases r.status <;> simp [isTerminal]

/-- Serial case: never above the attested version (nor the input). -/
theorem upgrade_le_max (b : Bool) (r : Run) (e : Nat) (head : LogHead) :
    (upgrade b r e head r).run.spec ≤ max r.spec e := by
  rcases upgrade_serial_mem b r e head with h | h <;> rw [h] <;> omega

/-- An upgrade commits only against a non-terminal row whose spec is still the
input's, hands back the attested version, and the attested version is newer. -/
theorem upgrade_not_terminal (b : Bool) (input actual : Run) (e : Nat) (head : LogHead) (rk : Bool)
    (hup : (upgrade b input e head actual).outcome = .upgraded rk) :
    actual.status ≠ .terminal ∧ actual.spec = input.spec ∧
    (upgrade b input e head actual).run.spec = e ∧ input.spec < e := by
  unfold upgrade at hup ⊢
  simp only at hup ⊢
  have hE := abs_upgraded _ _ _ _ _ _ head (mem_allHeads head) _ _ _ _ hup
  have := abs_actualE _ _ _ _ _ _ head (mem_allHeads head) _ _ _ (actPendingNotTerminal actual) hE
  rw [hE]
  simp [isTerminal] at this ⊢
  refine ⟨?_, this.2.2.1, ?_⟩
  · intro h; simp [h] at this
  · omega

/-- An upgrade that crosses 6 or 7 happened only on a pending run whose log was
exactly `[run_created]` — a ULID one when crossing 6 — both in the input and in
the row the transaction committed against. -/
theorem upgrade_crossing_requires_fresh (b : Bool) (input actual : Run) (e : Nat) (head : LogHead)
    (rk : Bool)
    (hup : (upgrade b input e head actual).outcome = .upgraded rk)
    (hcross : (input.spec < 6 ∧ 6 ≤ e) ∨ (input.spec < 7 ∧ 7 ≤ e)) :
    input.status = .pending ∧ actual.status = .pending ∧
    (∃ k, head = .runCreatedOnly k ∧ ((input.spec < 6 ∧ 6 ≤ e) → k = .ulid)) := by
  unfold upgrade at hup
  simp only at hup
  have hE := abs_upgraded _ _ _ _ _ _ head (mem_allHeads head) _ _ _ _ hup
  have h := (abs_actualE _ _ _ _ _ _ head (mem_allHeads head) _ _ _ (actPendingNotTerminal actual) hE).2.2.2.2.2
    ((requiresFreshLog_iff _ _).2 hcross)
  obtain ⟨hip, hap, hh⟩ := h
  refine ⟨by simpa using hip, by simpa using hap, ?_⟩
  rcases hh with hh | ⟨hh, hrk⟩
  · exact ⟨.ulid, hh, fun _ => rfl⟩
  · refine ⟨.slot, hh, fun hc => ?_⟩
    have := (rekey_iff _ _).2 hc
    simp [this] at hrk

/-- The #1044 hazard as a concrete witness: a starter holding a stale
`pending@5` snapshot (read before a concurrent starter upgraded the run to 8 and
started it) reads the head `[run_created(slot1), run_started(slot2)]`, skips with
`log-not-fresh`, and gets back its stale `pending@5` run. Downstream
(`resolveEventId`, events.ts:8280) numbers its event in ULID mode and
`handleRunStateTransition` (events.ts:2376-2415) re-patches the run to running
without a condition: a ULID lands in a slot-mode (spec 8) log. -/
theorem stale_skip_returns_stale :
    upgrade false ⟨5, .pending⟩ 8 (.runCreatedThenMore .slot) ⟨8, .running⟩ =
      { outcome := .skipped .logNotFresh, run := ⟨5, .pending⟩ } ∧
    idKindFor (upgrade false ⟨5, .pending⟩ 8 (.runCreatedThenMore .slot) ⟨8, .running⟩).run.spec = .ulid := by
  decide

/-- The same for `run-created-not-committed`: the head was read before
`run_created` landed; the stale run comes back. -/
theorem stale_not_committed_returns_stale :
    upgrade false ⟨3, .pending⟩ 8 .empty ⟨3, .pending⟩ =
      { outcome := .skipped .runCreatedNotCommitted, run := ⟨3, .pending⟩ } := by
  decide

/-- With the proposed reread-on-skip fix the post-read skip returns the reread. -/
theorem reread_fix_returns_actual :
    (upgrade true ⟨5, .pending⟩ 8 (.runCreatedThenMore .slot) ⟨8, .running⟩).run = ⟨8, .running⟩ := by
  decide

/-- ...but a reread cannot help `run-created-not-committed` when the reread
itself precedes the concurrent upgrade: the fix has to be on the
`run_started` transition (see `CrossDeploy.StaleSkip`). -/
theorem reread_fix_not_committed_still_stale :
    (upgrade true ⟨3, .pending⟩ 8 .empty ⟨3, .pending⟩).run = ⟨3, .pending⟩ := by
  decide

/-- `hmono` is needed: when the row was rebuilt below the input (recovery delete +
resilient re-create at a lower stamp), the lost-race reread hands back the lower version. -/
theorem upgrade_can_lower_without_hmono :
    (upgrade false ⟨5, .pending⟩ 8 (.runCreatedOnly .ulid) ⟨3, .pending⟩).run.spec = 3 := by
  decide

/-! ## Spec-version classification (vercel/workflow#4366 @ 03e6e6771)

`packages/world/src/spec-version.ts:190-232` (commit 25a529385):

* `CAPABILITY_ONLY_SPEC_VERSIONS = {3, 4, 5, 8}` (CBOR queue transport,
  attributes, compression, hook force-claim);
* `STRUCTURAL_SPEC_VERSIONS = {2, 6, 7}` (event sourcing, slot identity,
  sealed log); anything not in the capability set counts as structural,
  including LEGACY 1 and every future version;
* `crossesStructuralSpecVersion(from, to)`: `for (v = from + 1; v <= to; v++)
  if (!CAPABILITY_ONLY.has(v)) return true; return false`.

`crossesStructural` below is that loop over Nat (the arguments are spec
versions; non-integer inputs are out of scope). No caller in the client repo
uses it yet (it is exported for workflow-server#1044's mid-run raise).
-/

/-- `CAPABILITY_ONLY_SPEC_VERSIONS.has(v)`. -/
def capabilityOnly (v : Nat) : Bool := v == 3 || v == 4 || v == 5 || v == 8

/-- `STRUCTURAL_SPEC_VERSIONS.has(v)`. -/
def structuralListed (v : Nat) : Bool := v == 2 || v == 6 || v == 7

/-- `crossesStructuralSpecVersion(from, to)`: the loop visits `from+1 .. to`. -/
def crossesStructural (fromV toV : Nat) : Bool :=
  (List.range (toV - fromV)).any fun i => !capabilityOnly (fromV + 1 + i)

/-- The listed sets partition 2..8; 1 (LEGACY) and ≥ 9 are unclassified. -/
theorem classification_partition :
    (List.range 12).all (fun v =>
      !(capabilityOnly v && structuralListed v) &&
      ((capabilityOnly v || structuralListed v) == decide (2 ≤ v ∧ v ≤ 8))) = true := by decide

/-- What the loop guarantees: it returns false exactly when every version the
move passes over, `from < v ≤ to`, is capability-only. -/
theorem crossesStructural_false_iff (f t : Nat) :
    crossesStructural f t = false ↔ ∀ v, f < v → v ≤ t → capabilityOnly v = true := by
  unfold crossesStructural
  constructor
  · intro h v h1 h2
    have := (List.any_eq_false.mp h) (v - f - 1) (List.mem_range.mpr (by omega))
    have e : f + 1 + (v - f - 1) = v := by omega
    rw [e] at this; simpa using this
  · intro h
    apply List.any_eq_false.mpr
    intro i hi
    have := h (f + 1 + i) (by omega) (by have := List.mem_range.mp hi; omega)
    simp [this]

/-- Equivalently: it counts a move as structural iff it passes over some version
that is not capability-only (a listed structural one, LEGACY 1, or any
unclassified future version). -/
theorem crossesStructural_true_iff (f t : Nat) :
    crossesStructural f t = true ↔ ∃ v, f < v ∧ v ≤ t ∧ capabilityOnly v = false := by
  constructor
  · intro h
    apply Classical.byContradiction
    intro hn
    have : crossesStructural f t = false := (crossesStructural_false_iff f t).mpr (by
      intro v h1 h2
      cases hc : capabilityOnly v
      · exact absurd ⟨v, h1, h2, hc⟩ hn
      · rfl)
    simp_all
  · rintro ⟨v, h1, h2, h3⟩
    cases h : crossesStructural f t
    · have := (crossesStructural_false_iff f t).mp h v h1 h2; simp_all
    · rfl

/-- Crossing a listed structural version always counts. -/
theorem crosses_listed_structural {f t v : Nat} (h1 : f < v) (h2 : v ≤ t)
    (hs : structuralListed v = true) : crossesStructural f t = true :=
  (crossesStructural_true_iff f t).mpr ⟨v, h1, h2, by
    unfold structuralListed at hs; unfold capabilityOnly
    simp at hs ⊢; omega⟩

/-- ...and so does crossing any version ≥ 9 (unclassified is structural). -/
theorem crosses_unclassified_future {f t v : Nat} (h1 : f < v) (h2 : v ≤ t) (h9 : 9 ≤ v) :
    crossesStructural f t = true :=
  (crossesStructural_true_iff f t).mpr ⟨v, h1, h2, by unfold capabilityOnly; simp; omega⟩

/-- No splitting a structural move into capability-only hops: for `f ≤ m ≤ t`
the whole move crosses iff one of the hops does. -/
theorem crossesStructural_split {f m t : Nat} (h1 : f ≤ m) (h2 : m ≤ t) :
    crossesStructural f t = (crossesStructural f m || crossesStructural m t) := by
  cases hft : crossesStructural f t
  · have a := (crossesStructural_false_iff f t).mp hft
    have hfm : crossesStructural f m = false :=
      (crossesStructural_false_iff f m).mpr fun v x y => a v x (by omega)
    have hmt : crossesStructural m t = false :=
      (crossesStructural_false_iff m t).mpr fun v x y => a v (by omega) y
    simp [hfm, hmt]
  · obtain ⟨v, hv1, hv2, hv3⟩ := (crossesStructural_true_iff f t).mp hft
    by_cases hv : v ≤ m
    · have : crossesStructural f m = true := (crossesStructural_true_iff f m).mpr ⟨v, hv1, hv, hv3⟩
      simp [this]
    · have : crossesStructural m t = true :=
        (crossesStructural_true_iff m t).mpr ⟨v, by omega, hv2, hv3⟩
      simp [this]

/-- A capability-only move leaves the log layout alone: event sourcing (≥ 2),
id mode (slot iff ≥ 6) and the sealed log (≥ 7) are the same on both sides.
This is the property a mid-run raise relies on ("nothing already in the run's
log changes meaning"). -/
theorem capabilityOnly_move_preserves_layout {f t : Nat} (hle : f ≤ t)
    (h : crossesStructural f t = false) :
    (2 ≤ f ↔ 2 ≤ t) ∧ usesSlotIdentity f = usesSlotIdentity t ∧
    usesSealedLog f = usesSealedLog t ∧ idKindFor f = idKindFor t := by
  have a := (crossesStructural_false_iff f t).mp h
  have n : ∀ k, capabilityOnly k = false → (k ≤ f ∨ t < k) := fun k hk => by
    by_cases x : f < k
    · by_cases y : k ≤ t
      · have := a k x y; simp_all
      · omega
    · omega
  have n2 := n 2 (by decide)
  have n6 := n 6 (by decide)
  have n7 := n 7 (by decide)
  refine ⟨by omega, ?_, ?_, ?_⟩
  · unfold usesSlotIdentity
    by_cases x : 6 ≤ f
    · simp [x, show 6 ≤ t by omega]
    · simp [x, show ¬ 6 ≤ t by omega]
  · unfold usesSealedLog
    by_cases x : 7 ≤ f
    · simp [x, show 7 ≤ t by omega]
    · simp [x, show ¬ 7 ≤ t by omega]
  · unfold idKindFor
    by_cases x : 6 ≤ f
    · simp [x, show 6 ≤ t by omega]
    · simp [x, show ¬ 6 ≤ t by omega]

/-- #1044's own fresh-log test (crossing 6 or 7, `requiresFreshLog`) is subsumed:
every move it restricts is structural by the client's classification. -/
theorem requiresFreshLog_structural (f t : Nat) (h : requiresFreshLog f t = true) :
    crossesStructural f t = true := by
  rw [requiresFreshLog_iff] at h
  rcases h with ⟨h1, h2⟩ | ⟨h1, h2⟩
  · exact crosses_listed_structural (v := 6) h1 h2 (by decide)
  · exact crosses_listed_structural (v := 7) h1 h2 (by decide)

/-- ...but not conversely: the classification is stricter than `requiresFreshLog`
exactly on crossings of 2 (event sourcing; from LEGACY, which #1044 routes to the
legacy handler first) and of ≥ 9 (future versions). A server that only checked
`requiresFreshLog` would let a running 8 move to 9. -/
theorem classification_stricter_than_fresh :
    crossesStructural 8 9 = true ∧ requiresFreshLog 8 9 = false ∧
    crossesStructural 1 3 = true ∧ requiresFreshLog 1 3 = false ∧
    ((List.range 11).all fun f => (List.range 11).all fun t =>
      !(crossesStructural f t && !requiresFreshLog f t) ||
        ((List.range 11).any fun v => decide (f < v) && decide (v ≤ t) && (v == 2 || v == 1 || 9 ≤ v))) = true := by
  decide

/-- The mid-run-safe moves among 1..9: (2→3,4,5), (3→4,5), (4→5), (7→8). -/
theorem capabilityOnly_moves :
    ((List.range 10).flatMap fun f => (List.range 10).filterMap fun t =>
      if 1 ≤ f && f < t && !crossesStructural f t then some (f, t) else none) =
    [(2, 3), (2, 4), (2, 5), (3, 4), (3, 5), (4, 5), (7, 8)] := by decide

end CrossDeploy
