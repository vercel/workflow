import CrossDeploy.Spec
/-!
# CrossDeploy.Raise — the backend raise decision (vercel/workflow-server#1044)

Pure model of `upgradeRunSpecVersion` (workflow-server d0575db
lib/data/run-spec-version-upgrade.ts:80-209). The function receives the run
object the request holds (`input`, possibly stale), the executor's attested
version `e` (#4366: `executorSpecVersion = mintedSpecVersion()`), the strongly
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

end CrossDeploy
