import CrossDeploy.Raise
import Std.Data.HashMap
import Std.Data.HashSet
/-!
# CrossDeploy.StaleSkip — concurrent writers of one run against #1044 (explicit-state model)

This is an explicit-state model checker, written in Lean, for every write that can
touch a run's row or log while its spec version can still change. It explores
the full reachable state graph with a visited set (BFS, with the interchangeable
starters sorted into canonical order), checks the invariants on every reachable
state, checks the end-state properties on every quiescent state (a state with no
successor), and checks one liveness property (from every reachable state some
quiescent state is still reachable). The results are asserted with
`native_decide`, so the Lean compiler joins the kernel in the trusted base,
the same trust level as a TLC run. The pure decision functions are reused from
`CrossDeploy.Raise`, whose theorems the kernel checks.

## Actors (workflow-server d0575db unless noted)

**Starters** (`Starter`, any number, each looping forever). Each one is a queue
delivery of `run_started` (redelivery, turbo re-invocation, world-vercel
event-retry, a second executor), and a retryable failure sends it back to
`readRun` as a fresh request. Its attested version `e` is `some (mintedSpecVersion())`
(#4366) or `none` (stable, or no #4366).

| pc          | code |
|-------------|------|
| `readRun`   | `fetchAndValidateRun`, events.ts:8019-8055. It misses only if the row is really absent: both the preload (v4/events.ts:535-548) and `fetchRunByIdForTenant` fall back to a consistent read on a miss (runs.ts:750-790, consistent-read.ts:50-80). A stale *hit* is the same as a delayed read, so the interleaving already covers it. A terminal row gives 410 (events.ts:2159-2220). spec ≤ 1 goes to the legacy handler. |
| `readHead`  | the `upgradeRunSpecVersion` pre-read skips (run-spec-version-upgrade.ts:96-109), then the consistent two-event head (events.ts:1627-1634) |
| `tx`        | the upgrade transaction against the row as it is now (run-spec-version-upgrade.ts:124-208). On success it sets row.spec := e and either re-keys run_created from ULID to slot 1 (sp := e) or patches run_created's sp. If the row is missing, the reread is `null` and `reread ?? run` hands back the input (:186-196). |
| `resCreate` | resilient start: `handleRunCreated` from eventData at `input.specVersion` = the caller's stamp (events.ts:8056-8150, headers.ts:163-170). On a conflict it refetches without calling the upgrade (events.ts:8222-8236). |
| `resRc`     | synthetic run_created: slot 1 when the stamp is ≥ 6, adopting an existing run_created there, else a fresh ULID (events.ts:8130-8215) |
| `patch`     | `handleRunStateTransition(run_started)` (events.ts:2376-2415): an unconditional patch to running, or `alreadyRunning` when the held status is running. The id assignment (`asg`) was fixed from the held spec BEFORE this step (`resolveEventId` + `allocatorFor(held.spec)`, events.ts:8280-8295). |
| `seqTake`   | `SlotSequencer.allocate` → `takeSequencedBlock`: unconditional `ADD seq 1`, position = seq + 1 (event-sequence.ts:42-70) |
| `insert`    | the event-row insert: ULID, probing `SlotAllocator` (max slot + 1, floor 2; 500 `slot-log-mixed-identity` when a ULID is on top, event-slot-identity.ts:171-193), or the sequencer position under the conditional-create fence. A fence conflict makes the sequencer repair itself: `raiseFloor(probeMaxSlot())` then a fresh block (slot-sequencer.ts:141-180, event-sequence.ts:80-120). |

An `alreadyRunning` starter whose `run_started` row is missing enters the v4
missing-run-event recovery (v4/events.ts:1650-1830). Inside the grace window, or
while a writer is still in flight, it gets a 503 and retries. Past the window,
on a wedged run (running, no run_started, no progress), it deletes only the run
row and retries, which then goes through resilient start.

**Client `run_created`** (`c`): `handleRunCreated` writes the run row (C1:
conditional create, 409 when it already exists) and later, as a separate write,
the run_created event (C2: ULID below 6, slot 1 at ≥ 6), events.ts:1979-2133 and
9562-9600.

**Terminal writer** (`TermW`, optional): `run_cancelled` (user cancel) or
`run_failed` (MAX_DELIVERIES, setup failure). It is allowed on a pending run
(events.ts:2213 rejects only non-lifecycle events). Its id mode comes from the
run it holds (events.ts:8280). In slot mode (held spec ≥ 6), the guarded patch
`status ∉ terminal` and the event row commit in one transaction
(`commitRunPatchWithEvent`, ATOMIC_RUN_TRANSITIONS, event-entity-transaction.ts:103-107).
In ULID mode the guarded patch comes first and the insert follows separately
(events.ts:2417-2650).

**Crash**: a writer can die after its run_started patch committed (a wedge), or
after it took a sequencer position (an abandoned hole). One crash per run.

## Properties

Invariants, on every reachable state:
* `noMixed`: a row at ≥ 6 has only slot ids. Otherwise `probeMaxSlot` returns
  500 and the v5 `requireEventSlot` throws (slot-identity.ts:116-124).
* `oneStarted` / `oneCreated`: at most one run_started / run_created event.
* `terminalAbsorbing`: once terminal, always terminal.
* `monotone`: the persisted spec never goes down, including across a row
  delete and rebuild.
* `noAlloc500`: no allocation ever hits `slot-log-mixed-identity`.
* `uniqueSlots`: no two events share a slot.
* `rcAgrees`: the first run_created's sp equals the row spec. world-vercel
  rebuilds the run from that event (world-vercel events.ts:816-829).

End state, on quiescent states:
* `idsMatchSpec`: all ids are slots ⟺ spec ≥ 6.
* `raised`: spec ≥ 6. Asserted only where some starter attests ≥ 6.
* `holesOk`: a spec-6 log is dense from slot 2. In a sealed (≥ 7) log every hole
  is an abandoned sequencer position, which the read-side sealer turns into a
  noop (event-log-sealing.ts).
* `started`: the run is not left pending.
* `rowPresent`: the run row exists.

Liveness:
* `canFinish`: from every reachable state some quiescent state is reachable.
  This rules out 503 retry loops that never end, such as a wedge with recovery
  switched off.

## Fix variants (`Cfg`); none of these is in #1044
* `rereadOnSkip`: post-read upgrade skips hand back the reread run.
* `cas`: the run_started patch is conditioned on `status == pending ∧ spec == held.spec`.
  On a conditional failure it rereads: running means alreadyRunning, terminal
  means reject, a moved spec means retry.
* `reresolve`: after a CAS failure, the event id assignment is re-resolved from
  the reread run. Without it the retried patch still inserts with the id mode
  it resolved first, which is what adding only a `.where` would do.
* `wait`: a head read that finds no run_created fails retryably and does not skip.
* `resilientUpgrade`: resilient start, both the winner and the conflict
  refetch, runs the upgrade.
* `casTerminal`: the terminal patch is also conditioned on `spec == held.spec`,
  and is re-resolved on failure.
* `adoptOrphan`: resilient start that finds a surviving run_created, the orphan
  of the missing-run-event recovery, adopts it and takes its spec:
  row.spec := max(stamp, orphan.sp).
* `recoveryReset`: the missing-run-event recovery resets the wedged run to
  `pending` (a patch conditioned on `status == running`) and keeps the row,
  instead of deleting it and rebuilding it through resilient start. The cost is
  paid only on that rare path.

## Results (the theorems below; the witnesses are in results/StaleSkip.txt)

On #1044 as written (`asIs`), with two starters that both attest ≥ 6 and a stamp < 6:
* `noMixed` fails on every start path, including the fresh one. This is the
  stale-skip race: a starter holding a pre-upgrade `pending@stamp` reaches the
  head after another starter re-keyed it, skips with `log-not-fresh` or
  `run-created-not-committed` and gets its stale run back, and then patches
  and numbers its run_started in ULID mode inside the slot log. It does not even
  need the winner to have started the run.
* `noAlloc500` fails: the next probing write then gets `slot-log-mixed-identity`.
* `oneStarted` fails: the run_started patch is unconditional, which predates #1044.
* `raised` fails on the late and missing paths.
* With a terminal writer, `terminalAbsorbing` fails (a stale run_started
  resurrects a cancelled run), and so does `canFinish`: a running run with a
  mixed log retries with 503 forever.
* With a crash, the delete-and-rebuild recovery breaks `monotone` (8 → stamp),
  `oneCreated`, `rcAgrees` (the orphan run_created at sp 8 over a row at the
  stamp), and `holesOk` (a sequencer hole left in a log rebuilt at 6).
* Stamps ≥ 6 never see a ULID; only the duplicate run_started remains.

The fixes, cumulatively:
* `rereadOnSkip` alone repairs only the fresh path.
* `cas` without `reresolve`, the natural `.where` fix, still writes a stale-mode ULID.
* `cas` + `reresolve` removes the mixed log and the duplicate. What remains is
  the run-created-not-committed residual (not raised).
* `wait` closes that residual when the row exists.
* `resilientUpgrade` closes it when the row is missing. It must skip legacy
  (≤ 1) runs: without that guard the model raises a legacy run to 6.
* `casTerminal` closes the stale terminal writer.
* `recoveryReset` closes the whole recovery family. `adoptOrphan` is not
  enough: the client's own late run_created can re-create a deleted row at the
  stamp.

With every fix (`allFixes`), all properties hold for two and three starters, a
terminal writer, and a crash with recovery, on every start path, and for
everything at once (`full_allFixes`: two starters + terminal writer + crash, row
absent, stamps 3/6/8). They also hold with the sequencer switched off, and even
if a read could miss an existing row. A recovery that fires on a writer that is
merely slower than the grace window still duplicates run_started, so the grace
window is load-bearing. With no recovery at all, a crash between the patch and
the insert wedges the run (`canFinish`).

Bounds: stamps {3,6,7,8} (2..5 checked equal to 3), attestations from {6,7,8},
N ≤ 3 starters, each retrying without bound (every retry is a fresh request),
at most one crash, at most one terminal writer. The run_created path and the
upgrade transaction are exact. Other event types (steps, hooks, waits) are
rejected on a pending run (events.ts:2213) and are not modelled.
Environment flags: `recovery` (v4 missing-run-event recovery on),
`slowWriter` (recovery may fire while a writer is still in flight, i.e. a
writer that is slower than the grace window), `seqEnabled`
(`sealedLog.sequencerEnabled`), and `readMiss` (ablation: a read of an
existing row may miss, which the code excludes).
-/
open Std

namespace CrossDeploy
deriving instance Hashable, Ord for Status
deriving instance Hashable, Ord for IdKind
deriving instance Hashable, Ord for Run
deriving instance Hashable, Ord for LogHead
end CrossDeploy

namespace CrossDeploy.Race
open CrossDeploy

inductive EvTy where
  | rc
  | rs
  | term
deriving DecidableEq, Repr, Hashable, Ord

inductive Id where
  | ulid
  | slot (n : Nat)
deriving DecidableEq, Repr, Hashable, Ord

/-- An event row. `sp` is its stored specVersion, tracked only for run_created
(it is 0 on the others). -/
structure Ev where
  ty : EvTy
  id : Id
  sp : Nat
deriving DecidableEq, Repr, Hashable, Ord

def Ev.isSlot (e : Ev) : Bool := match e.id with | .slot _ => true | .ulid => false
def Ev.slotNo (e : Ev) : Nat := match e.id with | .slot n => n | .ulid => 0
def Ev.kind (e : Ev) : IdKind := if e.isSlot then .slot else .ulid

structure Db where
  row : Option Run
  /-- insertion order -/
  log : List Ev
  /-- sequencer counter (0 = item absent) -/
  seq : Nat
deriving DecidableEq, Repr, Hashable, Ord

/-- Event id assignment fixed at transition entry (events.ts:8280-8295). -/
inductive Asg where
  | ulid
  | probe
  | seq
deriving DecidableEq, Repr, Hashable, Ord

inductive Pc where
  | readRun
  | readHead
  | tx
  | resCreate
  | resRc
  | patch
  | seqTake
  | insert
  | done
deriving DecidableEq, Repr, Hashable, Ord

structure Starter where
  e : Option Nat
  pc : Pc
  held : Run
  head : LogHead
  asg : Asg
  pos : Nat
deriving DecidableEq, Repr, Hashable, Ord

inductive TPc where
  | readRun
  | patch
  | seqTake
  | insert
  | done
deriving DecidableEq, Repr, Hashable, Ord

structure TermW where
  pc : TPc
  held : Run
  asg : Asg
  pos : Nat
deriving DecidableEq, Repr, Hashable, Ord

structure Cfg where
  rereadOnSkip : Bool := false
  cas : Bool := false
  reresolve : Bool := false
  wait : Bool := false
  resilientUpgrade : Bool := false
  casTerminal : Bool := false
  adoptOrphan : Bool := false
  recoveryReset : Bool := false
  recovery : Bool := true
  slowWriter : Bool := false
  seqEnabled : Bool := true
  readMiss : Bool := false
deriving DecidableEq, Repr

structure St where
  db : Db
  ss : List Starter
  /-- client run_created: 0 = row not created yet, 1 = row created / event pending, 2 = done -/
  c : Nat
  t : TermW
  crash : Nat
  stamp : Nat
  everTerm : Bool
  maxSpec : Nat
  lowered : Bool
  a500 : Bool
deriving DecidableEq, Repr, Hashable, Ord

/-! ## Log helpers -/

def insertSorted (e : Ev) : List Ev → List Ev
  | [] => [e]
  | x :: xs => if e.slotNo ≤ x.slotNo then e :: x :: xs else x :: insertSorted e xs

/-- Id order: slot ids ascending (slot 1 = run_created), then ULIDs in insertion
order; ULIDs sort above every slot (event-slot-identity.ts:171-193). -/
def sorted (l : List Ev) : List Ev :=
  (l.filter Ev.isSlot).foldl (fun acc e => insertSorted e acc) [] ++ l.filter (!·.isSlot)

def headOf (l : List Ev) : LogHead :=
  match sorted l with
  | [] => .empty
  | [e] => if e.ty == .rc then .runCreatedOnly e.kind else .otherFirst
  | e :: _ :: _ => if e.ty == .rc then .runCreatedThenMore e.kind else .otherFirst

def hasUlid (l : List Ev) : Bool := l.any (!·.isSlot)
def maxSlot (l : List Ev) : Nat := l.foldl (fun m e => max m e.slotNo) 0
def slotTaken (l : List Ev) (n : Nat) : Bool := l.any (fun e => e.isSlot && e.slotNo == n)
def countTy (l : List Ev) (t : EvTy) : Nat := (l.filter (·.ty == t)).length
def firstRc (l : List Ev) : Option Ev := (sorted l).find? (·.ty == .rc)

def asgFor (cfg : Cfg) (v : Nat) : Asg :=
  if v < 6 then .ulid else if 7 ≤ v && cfg.seqEnabled then .seq else .probe

/-- `raiseSequenceFloor(probeMaxSlot())`: seq := max - 1 when seq is below it. -/
def raiseFloor (db : Db) : Db :=
  let f := maxSlot db.log - 1
  if db.seq < f then { db with seq := f } else db

/-- Re-key: the first ULID run_created becomes slot 1 with sp := e (delete + create). -/
def rekeyLog (l : List Ev) (e : Nat) : List Ev :=
  match l.findIdx? (fun ev => ev.ty == .rc && !ev.isSlot) with
  | some i => l.set i ⟨.rc, .slot 1, e⟩
  | none => l

/-- Patch the head run_created's specVersion. -/
def patchRcSp (l : List Ev) (e : Nat) : List Ev :=
  match firstRc l with
  | some r => match l.idxOf? r with
    | some i => l.set i { r with sp := e }
    | none => l
  | none => l

def preReadSkip (held : Run) (e : Nat) : Bool :=
  decide (e ≤ held.spec) || isTerminal held.status ||
    (requiresFreshLog held.spec e && held.status != .pending)

/-! ## Scenario and initial state -/

structure Scenario where
  stamp : Nat
  es : List (Option Nat)
  /-- 0 = run row not created yet (resilient start reachable), 1 = row committed,
  run_created event pending, 2 = row and run_created committed (fresh) -/
  c0 : Nat := 1
  term : Bool := false
  crashes : Nat := 0
deriving DecidableEq, Repr

/-- Forget the local fields a phase no longer reads (they are rewritten before
they are read again), so that states differing only in dead values coincide. -/
def Starter.norm (s : Starter) : Starter :=
  match s.pc with
  | .done | .readRun | .resCreate => { s with held := ⟨0, .pending⟩, head := .empty, asg := .ulid, pos := 0 }
  | .readHead | .resRc => { s with head := .empty, asg := .ulid, pos := 0 }
  | .tx => { s with asg := .ulid, pos := 0 }
  | .patch => { s with head := .empty, pos := 0 }
  | .seqTake => { s with head := .empty, pos := 0, held := ⟨0, .pending⟩ }
  | .insert => { s with head := .empty, held := ⟨0, .pending⟩ }

def TermW.norm (t : TermW) : TermW :=
  match t.pc with
  | .done | .readRun => ⟨t.pc, ⟨0, .pending⟩, .ulid, 0⟩
  | .seqTake => { t with pos := 0 }
  | .patch => t
  | .insert => ⟨t.pc, ⟨0, .pending⟩, .ulid, 0⟩

def canon (st : St) : St :=
  { st with ss := (st.ss.map Starter.norm).foldl (fun acc s => insertBy s acc) [], t := st.t.norm }
where
  insertBy (s : Starter) : List Starter → List Starter
    | [] => [s]
    | x :: xs => if compare s x != .gt then s :: x :: xs else x :: insertBy s xs

def init (sc : Scenario) : St :=
  let row : Option Run := if sc.c0 = 0 then none else some ⟨sc.stamp, .pending⟩
  let log : List Ev := if sc.c0 = 2 then [⟨.rc, if 6 ≤ sc.stamp then .slot 1 else .ulid, sc.stamp⟩] else []
  canon { db := ⟨row, log, 0⟩
          ss := sc.es.map fun e => ⟨e, .readRun, ⟨0, .pending⟩, .empty, .ulid, 0⟩
          c := if sc.c0 = 2 then 2 else sc.c0
          t := ⟨if sc.term then .readRun else .done, ⟨0, .pending⟩, .ulid, 0⟩
          crash := sc.crashes
          stamp := sc.stamp
          everTerm := false
          maxSpec := if sc.c0 = 0 then 0 else sc.stamp
          lowered := false
          a500 := false }

/-! ## Transitions -/

/-- Book-keeping after every action: the monotone and terminal ghosts. -/
def ghost (st : St) : St :=
  match st.db.row with
  | none => st
  | some r =>
    { st with lowered := st.lowered || decide (r.spec < st.maxSpec)
              maxSpec := max st.maxSpec r.spec
              everTerm := st.everTerm || r.status == .terminal }

def toPatch (cfg : Cfg) (s : Starter) (held : Run) : Starter :=
  { s with held := held, asg := asgFor cfg held.spec, pos := 0, pc := .patch }

def retry (s : Starter) : Starter := { s with pc := .readRun, pos := 0 }

/-- Some other writer has patched `running` but not yet inserted its run_started. -/
def inFlight (st : St) (i : Nat) : Bool :=
  (st.ss.zipIdx.any fun (s, j) => j != i && (s.pc == .seqTake || s.pc == .insert))

abbrev Succ := List (String × St)

def stName : Status → String
  | .pending => "pending" | .running => "running" | .terminal => "terminal"
def kName : IdKind → String
  | .ulid => "ULID" | .slot => "slot"
def headName : LogHead → String
  | .empty => "[]" | .otherFirst => "[other,…]"
  | .runCreatedOnly k => s!"[rc:{kName k}]" | .runCreatedThenMore k => s!"[rc:{kName k},…]"
def skipName : SkipReason → String
  | .notNewer => "not-newer" | .terminal => "terminal" | .logNotFresh => "log-not-fresh"
  | .runCreatedNotCommitted => "run-created-not-committed" | .runCreatedNotFirst => "run-created-not-first"
def outName : Outcome → String
  | .upgraded _ => "upgraded" | .skipped r => "skip " ++ skipName r | .lostRace => "lost-race"
def asgName : Asg → String
  | .ulid => "ULID" | .probe => "probe" | .seq => "seq"

def setS (st : St) (i : Nat) (s : Starter) : St := { st with ss := st.ss.set i s }

/-- `alreadyRunning`: serve the run_started row if present, otherwise the
missing-run-event recovery (v4/events.ts:1650-1830). -/
def alreadyRunning (cfg : Cfg) (st : St) (i : Nat) (s : Starter) (lbl : String) : Succ :=
  if countTy st.db.log .rs > 0 then [(lbl ++ ":alreadyRunning", setS st i { s with pc := .done })]
  else
    let wedged := (st.db.log.all (·.ty == .rc)) && (cfg.slowWriter || !inFlight st i)
    let wait503 := (lbl ++ ":alreadyRunning-no-event-503", setS st i (retry s))
    if cfg.recovery && wedged then
      if cfg.recoveryReset then
        let row' := st.db.row.map fun r => if r.status == .running then { r with status := .pending } else r
        [wait503, (lbl ++ ":recovery-reset-pending", setS { st with db := { st.db with row := row' } } i (retry s))]
      else
        [wait503, (lbl ++ ":recovery-delete-row", setS { st with db := { st.db with row := none } } i (retry s))]
    else [wait503]

def stepStarter (cfg : Cfg) (st : St) (i : Nat) (s : Starter) : Succ :=
  let db := st.db
  let tag := s!"S{s.e.getD 0}"
  match s.pc with
  | .done => []
  | .readRun =>
    match db.row with
    | none => [(tag ++ ":readRun-missing→resilient", setS st i { s with pc := .resCreate })]
    | some r =>
      let miss := if cfg.readMiss then [(tag ++ ":readRun-miss(ablation)", setS st i { s with pc := .resCreate })] else []
      miss ++
      (if r.status == .terminal then [(tag ++ ":readRun-410", setS st i { s with pc := .done })]
       else if r.spec ≤ 1 then
         -- legacy handler: start in place, ULID
         let row' := if r.status == .pending then some { r with status := .running } else some r
         let log' := if r.status == .pending then db.log ++ [⟨.rs, .ulid, 0⟩] else db.log
         [(tag ++ ":legacy", setS { st with db := { db with row := row', log := log' } } i { s with pc := .done })]
       else if s.e.isSome then
         [(tag ++ s!":readRun {stName r.status}@{r.spec}", setS st i { s with held := r, pc := .readHead })]
       else [(tag ++ s!":readRun {stName r.status}@{r.spec}", setS st i (toPatch cfg s r))])
  | .readHead =>
    let e := s.e.getD 0
    if preReadSkip s.held e then [(tag ++ ":upgrade-preread-skip", setS st i (toPatch cfg s s.held))]
    else
      let h := headOf db.log
      if cfg.wait && h == .empty then [(tag ++ ":head-empty-retry", setS st i (retry s))]
      else [(tag ++ s!":readHead {headName h}", setS st i { s with head := h, pc := .tx })]
  | .tx =>
    let e := s.e.getD 0
    match db.row with
    | none => [(tag ++ ":tx-row-missing(reread ?? run)", setS st i (toPatch cfg s s.held))]
    | some act =>
      let r := upgrade cfg.rereadOnSkip s.held e s.head act
      match r.outcome with
      | .upgraded rk =>
        let ok := !rk || (!slotTaken db.log 1 && db.log.any (fun ev => ev.ty == .rc && !ev.isSlot))
        if ok then
          let log' := if rk then rekeyLog db.log e else patchRcSp db.log e
          [(tag ++ s!":tx-upgraded→{e}{if rk then " (rekey)" else ""}",
            setS { st with db := { db with row := some { act with spec := e }, log := log' } } i (toPatch cfg s r.run))]
        else [(tag ++ ":tx-cancelled", setS st i (toPatch cfg s act))]
      | o => [(tag ++ s!":tx {outName o}", setS st i (toPatch cfg s r.run))]
  | .resCreate =>
    match db.row with
    | none =>
      let orphan := if cfg.adoptOrphan then (firstRc db.log).map (·.sp) else none
      let sp := max st.stamp (orphan.getD 0)
      let row : Run := ⟨sp, .pending⟩
      [(tag ++ s!":resilient-create@{sp}", setS { st with db := { db with row := some row } } i { s with held := row, pc := .resRc })]
    | some r =>
      if r.status == .terminal then [(tag ++ ":resilient-conflict-410", setS st i { s with pc := .done })]
      else if cfg.resilientUpgrade && s.e.isSome && 2 ≤ r.spec then
        [(tag ++ ":resilient-conflict-refetch→upgrade", setS st i { s with held := r, pc := .readHead })]
      else [(tag ++ ":resilient-conflict-refetch", setS st i (toPatch cfg s r))]
  | .resRc =>
    let next := fun (st' : St) =>
      -- the proposed resilient upgrade must not raise a legacy (≤ 1) run: 1 → 2 is a different storage model
      if cfg.resilientUpgrade && s.e.isSome && 2 ≤ s.held.spec then setS st' i { s with pc := .readHead }
      else setS st' i (toPatch cfg s s.held)
    let slotMode := if cfg.adoptOrphan then 6 ≤ s.held.spec else 6 ≤ st.stamp
    if slotMode then
      if slotTaken db.log 1 then
        if db.log.any (fun ev => ev.slotNo == 1 && ev.ty == .rc && ev.isSlot) then
          [(tag ++ ":resilient-rc-adopt-slot1", next st)]
        else [(tag ++ ":resilient-rc-conflict-fail", setS st i (retry s))]
      else [(tag ++ ":resilient-rc slot1", next { st with db := { db with log := db.log ++ [⟨.rc, .slot 1, s.held.spec⟩] } })]
    else if cfg.adoptOrphan && (firstRc db.log).isSome then
      [(tag ++ ":resilient-rc-adopt-orphan", next st)]
    else [(tag ++ ":resilient-rc ULID", next { st with db := { db with log := db.log ++ [⟨.rc, .ulid, s.held.spec⟩] } })]
  | .patch =>
    let commit := fun (r : Run) =>
      let st' := { st with db := { db with row := some { r with status := .running } } }
      let nxt := if s.asg == .seq then Pc.seqTake else Pc.insert
      let ok := (tag ++ s!":patch-running(id {asgName s.asg})", setS st' i { s with pc := nxt })
      if st.crash > 0 then
        [ok, (tag ++ ":patch-running-then-CRASH", setS { st' with crash := st.crash - 1 } i (retry s))]
      else [ok]
    if !cfg.cas then
      if s.held.status == .running then alreadyRunning cfg st i s tag
      else match db.row with
        | none => [(tag ++ ":patch-404", setS st i (retry s))]
        | some r => commit r
    else
      match db.row with
      | none => [(tag ++ ":patch-404", setS st i (retry s))]
      | some r =>
        if r.status == .pending && r.spec == s.held.spec then commit r
        else if r.status == .running then alreadyRunning cfg st i { s with held := r } tag
        else if r.status == .terminal then [(tag ++ ":cas-fail-terminal", setS st i { s with pc := .done })]
        else
          let s' := if cfg.reresolve then toPatch cfg s r else { s with held := r }
          [(tag ++ s!":cas-fail-spec-moved→{r.spec}", setS st i s')]
  | .seqTake =>
    let db' := { db with seq := db.seq + 1 }
    let p := db.seq + 2
    let ok := (tag ++ s!":seqTake {p}", setS { st with db := db' } i { s with pos := p, pc := .insert })
    if st.crash > 0 then
      [ok, (tag ++ s!":seqTake {p}-then-CRASH", setS { st with db := db', crash := st.crash - 1 } i (retry s))]
    else [ok]
  | .insert =>
    match s.asg with
    | .ulid => [(tag ++ ":insert rs ULID", setS { st with db := { db with log := db.log ++ [⟨.rs, .ulid, 0⟩] } } i { s with pc := .done })]
    | .probe =>
      if hasUlid db.log then [(tag ++ ":probe-500-mixed", setS { st with a500 := true } i (retry s))]
      else
        let n := max 2 (maxSlot db.log + 1)
        [(tag ++ s!":insert rs slot{n}(probe)", setS { st with db := { db with log := db.log ++ [⟨.rs, .slot n, 0⟩] } } i { s with pc := .done })]
    | .seq =>
      if slotTaken db.log s.pos then
        if hasUlid db.log then [(tag ++ ":seq-conflict-repair-500-mixed", setS { st with a500 := true } i (retry s))]
        else [(tag ++ s!":seq-conflict {s.pos}-repair", setS { st with db := raiseFloor db } i { s with pc := .seqTake, pos := 0 })]
      else
        [(tag ++ s!":insert rs slot{s.pos}(seq)", setS { st with db := { db with log := db.log ++ [⟨.rs, .slot s.pos, 0⟩] } } i { s with pc := .done })]

def stepTerm (cfg : Cfg) (st : St) : Succ :=
  let db := st.db
  let t := st.t
  let setT := fun (st' : St) (t' : TermW) => { st' with t := t' }
  let entry := fun (r : Run) =>
    let a := asgFor cfg r.spec
    ({ t with held := r, asg := a, pos := 0, pc := if a == .seq then .seqTake else .patch } : TermW)
  match t.pc with
  | .done => []
  | .readRun =>
    match db.row with
    | none => [("T:readRun-404", setT st { t with pc := .done })]
    | some r =>
      if r.status == .terminal then [("T:readRun-409", setT st { t with pc := .done })]
      else [(s!"T:readRun {stName r.status}@{r.spec}", setT st (entry r))]
  | .seqTake =>
    let p := db.seq + 2
    [(s!"T:seqTake {p}", setT { st with db := { db with seq := db.seq + 1 } } { t with pos := p, pc := .patch })]
  | .patch =>
    match db.row with
    | none => [("T:patch-404", setT st { t with pc := .done })]
    | some r =>
      if r.status == .terminal then [("T:patch-409-already-finished", setT st { t with pc := .done })]
      else if cfg.casTerminal && r.spec != t.held.spec then
        [(s!"T:cas-fail-spec-moved→{r.spec}", setT st (entry r))]
      else
        let row' := some { r with status := .terminal }
        match t.asg with
        | .ulid => [("T:patch-terminal(ULID mode)", setT { st with db := { db with row := row' } } { t with pc := .insert })]
        | .probe =>
          if hasUlid db.log then [("T:probe-500-mixed", setT { st with a500 := true } { t with pc := .readRun })]
          else
            let n := max 2 (maxSlot db.log + 1)
            [(s!"T:atomic terminal+slot{n}(probe)", setT { st with db := { db with row := row', log := db.log ++ [⟨.term, .slot n, 0⟩] } } { t with pc := .done })]
        | .seq =>
          if slotTaken db.log t.pos then
            if hasUlid db.log then [("T:seq-repair-500-mixed", setT { st with a500 := true } { t with pc := .readRun })]
            else [("T:seq-conflict-repair", setT { st with db := raiseFloor db } { t with pc := .seqTake })]
          else
            [(s!"T:atomic terminal+slot{t.pos}(seq)", setT { st with db := { db with row := row', log := db.log ++ [⟨.term, .slot t.pos, 0⟩] } } { t with pc := .done })]
  | .insert => [("T:insert term ULID", setT { st with db := { db with log := db.log ++ [⟨.term, .ulid, 0⟩] } } { t with pc := .done })]

def stepClient (st : St) : Succ :=
  let db := st.db
  match st.c with
  | 0 =>
    match db.row with
    | none => [(s!"C:run_created row@{st.stamp}", { st with db := { db with row := some ⟨st.stamp, .pending⟩ }, c := 1 })]
    | some _ => [("C:run_created-409", { st with c := 2 })]
  | 1 =>
    if 6 ≤ st.stamp then
      if slotTaken db.log 1 then [("C:rc-slot1-conflict", { st with c := 2 })]
      else [("C:rc event slot1", { st with db := { db with log := db.log ++ [⟨.rc, .slot 1, st.stamp⟩] }, c := 2 })]
    else [("C:rc event ULID", { st with db := { db with log := db.log ++ [⟨.rc, .ulid, st.stamp⟩] }, c := 2 })]
  | _ => []

def succs (cfg : Cfg) (st : St) : Succ :=
  let raw := stepClient st ++ stepTerm cfg st ++
    (st.ss.zipIdx.flatMap fun (s, i) => stepStarter cfg st i s)
  raw.map fun (l, s) => (l, canon (ghost s))

/-! ## Properties -/

def allSlot (st : St) : Bool := st.db.log.all Ev.isSlot
def rowSpec (st : St) : Nat := (st.db.row.map (·.spec)).getD 0

def holes (st : St) : List Nat :=
  let m := maxSlot st.db.log
  (List.range (m + 1)).filter fun k => 2 ≤ k && !slotTaken st.db.log k

structure Prop' where
  name : String
  /-- invariant (every state) or end-state (quiescent states) -/
  inv : Bool
  f : St → Bool

def props : List Prop' :=
  [ ⟨"noMixed", true, fun st => match st.db.row with
      | some r => !decide (6 ≤ r.spec) || allSlot st
      | none => true⟩
  , ⟨"oneStarted", true, fun st => decide (countTy st.db.log .rs ≤ 1)⟩
  , ⟨"oneCreated", true, fun st => decide (countTy st.db.log .rc ≤ 1)⟩
  , ⟨"terminalAbsorbing", true, fun st => !st.everTerm ||
      (match st.db.row with | some r => r.status == .terminal | none => false)⟩
  , ⟨"monotone", true, fun st => !st.lowered⟩
  , ⟨"noAlloc500", true, fun st => !st.a500⟩
  , ⟨"uniqueSlots", true, fun st =>
      let sl := (st.db.log.filter Ev.isSlot).map Ev.slotNo
      sl.all fun n => (sl.filter (· == n)).length == 1⟩
  , ⟨"rcAgrees", true, fun st => match st.db.row, firstRc st.db.log with
      | some r, some rc => rc.sp == r.spec
      | _, _ => true⟩
  , ⟨"idsMatchSpec", false, fun st => match st.db.row with
      | some r => allSlot st == decide (6 ≤ r.spec)
      | none => true⟩
  , ⟨"raised", false, fun st => decide (6 ≤ rowSpec st) ||
      (match st.db.row with | some r => r.status == .terminal | none => false)⟩
  , ⟨"holesOk", false, fun st => match st.db.row with
      | some r => if 7 ≤ r.spec then (holes st).all (· ≤ st.db.seq + 1)
                  else if r.spec == 6 then (holes st).isEmpty else true
      | none => true⟩
  , ⟨"started", false, fun st => match st.db.row with
      | some r => r.status != .pending
      | none => true⟩
  , ⟨"rowPresent", false, fun st => st.db.row.isSome⟩ ]

/-! ## Explorer -/

structure Report where
  states : Nat
  quiescent : Nat
  /-- names of violated properties, in `props` order, then "canFinish" -/
  violated : List String
  /-- one shortest witness trace per violated property -/
  witnesses : List (String × List String)
  /-- distinct quiescent outcomes: (row spec, all ids are slots, status) -/
  outcomes : List (Nat × Bool × Option Status)
deriving Repr

def trace (parent : HashMap St (Option (St × String))) (st : St) : List String :=
  go parent st [] 400
where
  go (parent : HashMap St (Option (St × String))) (st : St) (acc : List String) : Nat → List String
    | 0 => acc
    | n + 1 => match parent.get? st with
      | some (some (p, l)) => go parent p (l :: acc) n
      | _ => acc

structure Search where
  seen : HashMap St (Option (St × String))
  order : Array St
  firstBad : List (String × St)
  quiescent : Nat
  qs : Array St
  outcomes : List (Nat × Bool × Option Status)
  rev : HashMap St (List St)

partial def bfs (cfg : Cfg) (live : Bool) (queue : Array St) (idx : Nat) (sr : Search) : Search :=
  if h : idx < queue.size then
    let st := queue[idx]
    let bad := props.filter (fun p => p.inv && !p.f st) |>.filter (fun p => !(sr.firstBad.any (·.1 == p.name)))
    let sr := { sr with firstBad := sr.firstBad ++ bad.map (·.name, st) }
    let ns := succs cfg st
    let sr := if ns.isEmpty then
        let endBad := props.filter (fun p => !p.inv && !p.f st) |>.filter (fun p => !(sr.firstBad.any (·.1 == p.name)))
        let o := (rowSpec st, allSlot st, st.db.row.map (·.status))
        { sr with quiescent := sr.quiescent + 1
                  qs := if live then sr.qs.push st else sr.qs
                  firstBad := sr.firstBad ++ endBad.map (·.name, st)
                  outcomes := if sr.outcomes.contains o then sr.outcomes else sr.outcomes ++ [o] }
      else sr
    let (queue, sr) := ns.foldl (fun (acc : Array St × Search) (l, n) =>
      let (q, sr) := acc
      let sr := if live then { sr with rev := sr.rev.insert n (st :: (sr.rev.getD n [])) } else sr
      if sr.seen.contains n then (q, sr)
      else (q.push n, { sr with seen := sr.seen.insert n (some (st, l)), order := sr.order.push n })) (queue, sr)
    bfs cfg live queue (idx + 1) sr
  else sr

/-- States that can reach a quiescent state (backward closure). -/
partial def backReach (rev : HashMap St (List St)) (todo : List St) (ok : HashSet St) : HashSet St :=
  match todo with
  | [] => ok
  | s :: rest =>
    let (todo', ok') := (rev.getD s []).foldl (fun (acc : List St × HashSet St) p =>
      if acc.2.contains p then acc else (p :: acc.1, acc.2.insert p)) (rest, ok)
    backReach rev todo' ok'

def explore (cfg : Cfg) (sc : Scenario) (live : Bool := true) : Report :=
  let s0 := canon (ghost (init sc))
  let sr0 : Search := ⟨(HashMap.emptyWithCapacity 4096).insert s0 none, #[s0], [], 0, #[], [], {}⟩
  let sr := bfs cfg live #[s0] 0 sr0
  let stuck : Option St :=
    if live then
      let qs := sr.qs.toList
      let ok := backReach sr.rev qs (qs.foldl (fun h s => h.insert s) {})
      sr.order.toList.find? (fun st => !ok.contains st)
    else none
  -- `raised` is asserted only when some starter attests ≥ 6
  let assertRaised := sc.es.any fun e => decide (6 ≤ e.getD 0)
  let bad := sr.firstBad.filter fun (n, _) => n != "raised" || assertRaised
  let bad := bad ++ (match stuck with | some st => [("canFinish", st)] | none => [])
  let order := props.map (·.name) ++ ["canFinish"]
  let names := order.filter fun n => bad.any (·.1 == n)
  { states := sr.order.size
    quiescent := sr.quiescent
    violated := names
    witnesses := names.filterMap fun n => (bad.find? (·.1 == n)).map fun (_, st) => (n, trace sr.seen st)
    outcomes := sr.outcomes }

/-! ## Variants -/

def asIs : Cfg := {}
def rereadOnly : Cfg := { rereadOnSkip := true }
/-- CAS on the patch only: the id assignment stays the stale one. -/
def casStaleId : Cfg := { cas := true }
def cas : Cfg := { cas := true, reresolve := true }
def casWait : Cfg := { cas := true, reresolve := true, wait := true }
def casWaitRes : Cfg := { casWait with resilientUpgrade := true }
def casWaitResTerm : Cfg := { casWaitRes with casTerminal := true }
/-- the delete-based recovery, patched to adopt the orphan run_created -/
def allFixesAdopt : Cfg := { casWaitResTerm with adoptOrphan := true }
/-- every proposed fix: the recovery resets the wedged run to pending instead of deleting it -/
def allFixes : Cfg := { casWaitResTerm with recoveryReset := true }

/-! ## Scenario families -/

def stamps : List Nat := [2, 3, 4, 5, 6, 7, 8]
/-- Every definition here reads a spec only through `≤ 1`, `6 ≤`, `7 ≤` and
comparisons with the attested `e ∈ {6,7,8}` or with other specs that are
themselves one of {stamp, e}; stamps 2..5 therefore behave alike. The printed
tables cover 2..8; theorems use the representatives. -/
def repStamps : List Nat := [3, 6, 7, 8]
def execs : List Nat := [6, 7, 8]
def pairs : List (Nat × Nat) := execs.flatMap fun a => (execs.filter (a ≤ ·)).map fun b => (a, b)

def famPairs (c0 : Nat) (ss : List Nat := repStamps) : List Scenario :=
  ss.flatMap fun s => pairs.map fun (a, b) => { stamp := s, es := [some a, some b], c0 := c0 }

/-- Two starters plus a terminal writer (run_cancelled / run_failed). -/
def famTerm (c0 : Nat) : List Scenario :=
  repStamps.flatMap fun s => [(6, 8), (8, 8)].map fun (a, b) =>
    { stamp := s, es := [some a, some b], c0 := c0, term := true }

/-- Two starters, one crash (after a run_started patch, or after a sequencer take). -/
def famCrash (c0 : Nat) : List Scenario :=
  repStamps.flatMap fun s => [(6, 8), (8, 8)].map fun (a, b) =>
    { stamp := s, es := [some a, some b], c0 := c0, crashes := 1 }

/-- Three concurrent starters, including split attestations (a WORKFLOW_SEALED_LOG=0 executor). -/
def triples : List (List (Option Nat)) :=
  [[some 6, some 8, some 8], [some 8, some 8, some 8], [some 6, some 6, some 8]]

def famTriples (c0 : Nat) : List Scenario :=
  [3, 6, 8].flatMap fun s => triples.map fun es => { stamp := s, es := es, c0 := c0 }

/-- Everything at once: two starters, a terminal writer, a crash, the run row absent. -/
def famFull : List Scenario :=
  [3, 6, 8].flatMap fun s => [(6, 8), (8, 8)].map fun (a, b) =>
    { stamp := s, es := [some a, some b], c0 := 0, term := true, crashes := 1 }

def viol (cfg : Cfg) (scs : List Scenario) (live : Bool := true) : List String :=
  let all := scs.flatMap fun sc => (explore cfg sc live).violated
  (props.map (·.name) ++ ["canFinish"]).filter all.contains

/-! ## Witnesses (replayed step by step) -/

/-- Replay a schedule given as a list of action-label prefixes. -/
def replay (cfg : Cfg) (st : St) : List String → Option St
  | [] => some st
  | l :: ls => match (succs cfg st).find? (fun (x, _) => x.startsWith l) with
    | some (_, st') => replay cfg st' ls
    | none => none

/-- The stale-skip interleaving on #1044 as written (stamp 5, both attest 8):
B reads pending@5; A upgrades (re-key → slot 1, spec 8); B's head read sees
`[rc:slot]` and skips `log-not-fresh` with its stale pending@5; B's unconditional
patch and ULID-numbered run_started land in the slot-8 log. -/
def staleSkipSchedule : List String :=
  ["C:rc event ULID", "S8:readRun pending@5", "S8:readRun pending@5", "S8:readHead [rc:ULID]",
   "S8:tx-upgraded→8 (rekey)", "S8:readHead [rc:slot]", "S8:tx skip log-not-fresh",
   "S8:patch-running(id ULID)", "S8:insert rs ULID"]

theorem staleSkip_witness :
    (match replay asIs (canon (ghost (init { stamp := 5, es := [some 8, some 8], c0 := 1 }))) staleSkipSchedule with
     | some st => st.db.row == some ⟨8, .running⟩ && st.db.log == [⟨.rc, .slot 1, 8⟩, ⟨.rs, .ulid, 0⟩]
     | none => false) = true := by native_decide

/-- The same prefix under the CAS transition with re-resolve: B's patch fails
(row is pending@8, not pending@5), B re-resolves to the sequencer and numbers its
event as a slot. -/
theorem staleSkip_cas_reresolves :
    (match replay cas (canon (ghost (init { stamp := 5, es := [some 8, some 8], c0 := 1 })))
        (staleSkipSchedule.take 7 ++ ["S8:cas-fail-spec-moved→8", "S8:patch-running(id seq)"]) with
     | some _ => true
     | none => false) = true := by native_decide

/-! ## Exhaustive results

Each theorem states the EXACT set of violated properties over a whole scenario
family (union over its scenarios); `[]` means every property holds in every
reachable state, every quiescent state, and liveness holds. -/

/-- Stamps 2, 4 and 5 behave exactly as the representative 3 (see `repStamps`). -/
theorem repStamps_sound :
    viol asIs (famPairs 1 [2, 4, 5]) = viol asIs (famPairs 1 [3]) ∧
    viol allFixes (famPairs 0 [2, 4, 5]) = viol allFixes (famPairs 0 [3]) := by native_decide

/-! ### Two starters -/

/-- #1044 as written, run_created event late: mixed log, duplicate run_started,
`slot-log-mixed-identity` 500s, and a stamp < 6 left un-raised. -/
theorem pairs_late_asIs :
    viol asIs (famPairs 1) = ["noMixed", "oneStarted", "noAlloc500", "idsMatchSpec", "raised"] := by native_decide

/-- ...and on the fresh path (run_created committed before any starter). -/
theorem pairs_fresh_asIs :
    viol asIs (famPairs 2) = ["noMixed", "oneStarted", "noAlloc500", "idsMatchSpec"] := by native_decide

/-- Reread-on-skip removes the mixed log on the fresh path only. -/
theorem pairs_fresh_reread : viol rereadOnly (famPairs 2) = ["oneStarted"] := by native_decide
theorem pairs_late_reread :
    viol rereadOnly (famPairs 1) = ["noMixed", "oneStarted", "noAlloc500", "idsMatchSpec", "raised"] := by native_decide

/-- A CAS on the patch alone (the natural `.where` fix) keeps the stale id
assignment and still writes a ULID into a slot log. -/
theorem pairs_late_casStaleId :
    viol casStaleId (famPairs 1) = ["noMixed", "idsMatchSpec", "raised"] := by native_decide

/-- CAS + re-resolve: safe; only the run-created-not-committed residual (un-raised) remains. -/
theorem pairs_late_cas : viol cas (famPairs 1) = ["raised"] := by native_decide
theorem pairs_fresh_cas : viol cas (famPairs 2) = [] := by native_decide
theorem pairs_late_casWait : viol casWait (famPairs 1) = [] := by native_decide

/-- Row missing (resilient start reachable): waiting is not enough, the
resilient path must run the upgrade too. -/
theorem pairs_missing_casWait : viol casWait (famPairs 0) = ["raised"] := by native_decide
theorem pairs_missing_casWaitRes : viol casWaitRes (famPairs 0) = [] := by native_decide

/-- Stamps ≥ 6 never see a ULID, even on #1044 as written (duplicate run_started remains). -/
theorem pairs_slotStamp_asIs : viol asIs (famPairs 0 [6, 7, 8]) = ["oneStarted"] := by native_decide

/-- Without #4366 nothing is raised: the ids always match the stamp (a stamp < 6
stays ULID for life, which Combined counts as a v5 brick) and the log is never
mixed; only the pre-existing duplicate run_started remains. -/
theorem noAttest_asIs :
    viol asIs ([3, 6].flatMap fun s => [0, 1, 2].map fun c => ({ stamp := s, es := [none, none], c0 := c } : Scenario)) =
      ["oneStarted"] := by native_decide

/-! ### Terminal writer (run_cancelled / run_failed) -/

/-- #1044 as written: a stale run_started resurrects a cancelled run, a stale
terminal writer writes a ULID into a raised log, and the run can livelock (503
forever on a running run with a mixed log). -/
theorem term_late_asIs :
    viol asIs (famTerm 1) =
      ["noMixed", "oneStarted", "terminalAbsorbing", "noAlloc500", "idsMatchSpec", "raised", "canFinish"] := by native_decide

/-- The run_started CAS stops the resurrection but not the stale terminal writer. -/
theorem term_late_casWaitRes :
    viol casWaitRes (famTerm 1) = ["noMixed", "noAlloc500", "idsMatchSpec"] := by native_decide

/-- Conditioning the terminal patch on the held spec (and re-resolving) closes it. -/
theorem term_late_casWaitResTerm : viol casWaitResTerm (famTerm 1) = [] := by native_decide
theorem term_missing_casWaitResTerm : viol casWaitResTerm (famTerm 0) = [] := by native_decide

/-! ### Crash + v4 missing-run-event recovery -/

/-- #1044 as written: the delete-and-rebuild recovery lowers an upgraded run
back to the stamp, duplicates run_created, mixes the log, and leaves a hole in a
spec-6 log. -/
theorem crash_fresh_asIs :
    viol asIs (famCrash 2) =
      ["noMixed", "oneStarted", "oneCreated", "monotone", "noAlloc500", "rcAgrees", "idsMatchSpec", "raised", "holesOk"] := by
  native_decide

/-- Every start-path fix, recovery unchanged: the rebuild still lowers the run. -/
theorem crash_fresh_casWaitResTerm :
    viol casWaitResTerm (famCrash 2) = ["oneCreated", "monotone", "rcAgrees", "raised"] := by native_decide

/-- Adopting the orphan run_created fixes the rebuild, except when the client's
own late run_created re-creates the deleted row at the stamp. -/
theorem crash_fresh_allFixesAdopt : viol allFixesAdopt (famCrash 2) = [] := by native_decide
theorem crash_missing_allFixesAdopt :
    viol allFixesAdopt (famCrash 0) = ["oneCreated", "monotone", "rcAgrees", "raised"] := by native_decide

/-- Resetting the wedged run to pending (instead of deleting it) closes all of it. -/
theorem crash_fresh_allFixes : viol allFixes (famCrash 2) = [] := by native_decide
theorem crash_late_allFixes : viol allFixes (famCrash 1) = [] := by native_decide
theorem crash_missing_allFixes : viol allFixes (famCrash 0) = [] := by native_decide

/-- Without any recovery a crash between the run_started patch and its insert
wedges the run: the retrying starter gets 503 forever. -/
theorem crash_fresh_noRecovery : viol { allFixes with recovery := false } (famCrash 2) = ["canFinish"] := by native_decide

/-! ### Three concurrent starters (N = 3) -/

theorem triples_late_asIs :
    viol asIs (famTriples 1) = ["noMixed", "oneStarted", "noAlloc500", "idsMatchSpec", "raised"] := by native_decide
theorem triples_late_allFixes : viol allFixes (famTriples 1) = [] := by native_decide
theorem triples_missing_allFixes : viol allFixes (famTriples 0) = [] := by native_decide

/-! ### Everything at once: two starters + terminal writer + crash + recovery, row absent -/

theorem full_allFixes : viol allFixes famFull false = [] := by native_decide

/-! ### Ablations -/

/-- Sequencer off (probing allocator on sealed runs): same verdicts. -/
theorem seqOff_allFixes : viol { allFixes with seqEnabled := false } (famCrash 1 ++ famTerm 1) = [] := by native_decide

/-- A recovery that fires on a writer that is merely slower than the grace
window duplicates run_started even with every fix (the grace window is load-bearing). -/
theorem slowWriter_allFixes : viol { allFixes with slowWriter := true } (famCrash 2) = ["oneStarted"] := by native_decide

/-- If a read of an existing row could miss (the code rules this out with its
consistent fallback), resilient start would conflict and refetch; every fix still holds. -/
theorem readMiss_allFixes : viol { allFixes with readMiss := true } (famPairs 1 ++ famTerm 1) = [] := by native_decide

/-! ## Report (printed into results/StaleSkip.txt) -/

def checks : List (String × String × Cfg × List Scenario × Bool) :=
  [("pairs, run_created late", "asIs(#1044)", asIs, famPairs 1, true),
   ("pairs, fresh", "asIs(#1044)", asIs, famPairs 2, true),
   ("pairs, fresh", "rereadOnSkip", rereadOnly, famPairs 2, true),
   ("pairs, run_created late", "cas-patch-only(stale id)", casStaleId, famPairs 1, true),
   ("pairs, run_created late", "cas+reresolve", cas, famPairs 1, true),
   ("pairs, row missing", "cas+reresolve+wait", casWait, famPairs 0, true),
   ("pairs, row missing", "…+resilientUpgrade", casWaitRes, famPairs 0, true),
   ("pairs + terminal writer", "asIs(#1044)", asIs, famTerm 1, true),
   ("pairs + terminal writer", "…+resilientUpgrade", casWaitRes, famTerm 1, true),
   ("pairs + terminal writer", "…+casTerminal", casWaitResTerm, famTerm 1, true),
   ("pairs + crash/recovery, fresh", "asIs(#1044)", asIs, famCrash 2, true),
   ("pairs + crash/recovery, fresh", "…+casTerminal", casWaitResTerm, famCrash 2, true),
   ("pairs + crash/recovery, row missing", "allFixesAdopt(delete+adopt orphan)", allFixesAdopt, famCrash 0, true),
   ("pairs + crash/recovery, row missing", "allFixes(reset to pending)", allFixes, famCrash 0, true),
   ("pairs + crash, no recovery", "allFixes", { allFixes with recovery := false }, famCrash 2, true),
   ("triples, run_created late", "asIs(#1044)", asIs, famTriples 1, true),
   ("triples, row missing", "allFixes", allFixes, famTriples 0, true),
   ("full (2 starters+terminal+crash, row missing)", "allFixes", allFixes, famFull, false)]

def showSc (sc : Scenario) : String :=
  s!"stamp={sc.stamp} executors={sc.es.map (·.getD 0)} c0={sc.c0} terminalWriter={sc.term} crashes={sc.crashes}"

#eval do
  IO.println "Explicit-state exploration (BFS, visited set, starters in canonical order)."
  IO.println "Per check: total states / quiescent states over the family, violated properties, and one"
  IO.println "shortest witness trace per violated property (first scenario of the family that violates it)."
  for (fn, cn, cfg, fam, live) in checks do
    let reps : List (Scenario × Report) := fam.map fun sc => (sc, explore cfg sc live)
    let states := reps.foldl (fun a (x : Scenario × Report) => a + x.2.states) 0
    let q := reps.foldl (fun a (x : Scenario × Report) => a + x.2.quiescent) 0
    let v := (props.map Prop'.name ++ ["canFinish"]).filter fun n => reps.any fun (x : Scenario × Report) => x.2.violated.contains n
    IO.println s!"\n=== [{fn}] {cn}: scenarios={fam.length} states={states} quiescent={q} violated={v}"
    let mut seenP : List String := []
    for (sc, r) in reps do
      for (p, w) in r.witnesses do
        if !seenP.contains p then
          seenP := seenP ++ [p]
          IO.println s!"  {p} @ {showSc sc}:\n    {String.intercalate " → " w}"

end CrossDeploy.Race
