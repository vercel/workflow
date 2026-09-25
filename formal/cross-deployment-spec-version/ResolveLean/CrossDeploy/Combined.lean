import CrossDeploy.Resolve
import CrossDeploy.Raise
import CrossDeploy.StaleSkip
/-!
# CrossDeploy.Combined — client stamp → server raise → executor acceptance

The end-to-end pipeline of the stack for one run:

1. **client** (`stampOf`). The stamp comes from one of these sources:
   * a v5 `start()`: `c` is the caller's `world.specVersion` ∈ [6, MAX]
     (world-compatibility.ts:36-56), and the stamp is `resolve (probeOf reply net) c`
     (start.ts:117-138, 504-588). The proposed floor-3 variant is also modelled.
   * an explicit `opts.specVersion`, which wins uncapped (start.ts:587-588).
   * `recreateRunFromExisting` onto the same deployment: `run.specVersion ?? 1`,
     explicit (runs.ts:83-130).
   * `recreateRunFromExisting` redirected to another deployment: unset, so it
     goes through `start()`'s probe.
   * the CLI `startRun` (cli/src/lib/inspect/run.ts:87-109): `min(hc, world)` only
     for a healthy numeric reply, otherwise `run.specVersion`. When that is unset
     too, `start()`'s own resolution applies.
   * a stable (v4) caller: always 3 (stable start.ts:248-252).
2. **server**. Two models:
   * *sequential* (`serverRaise`): one `run_started`, optionally one redelivery,
     no concurrency. It is kept for the unbounded theorems about the raise
     function.
   * *race-composed* (`raceOut`): every quiescent outcome of the concurrent
     model `CrossDeploy.StaleSkip`, with two concurrent starters of the target
     that both attest its version, the client's run_created, and the start
     path given as that model's initial state (fresh / run_created late /
     row missing, so resilient start is reachable). It is run twice: once
     against #1044 as written (`asIs`) and once with every proposed server fix
     (`allFixes`). Terminal writers, crashes and recovery are verified inside
     StaleSkip and are not composed here.
3. **executor / caller** (`fullOk`). The target accepts the final version iff
   `lo ≤ final ≤ hi`. A v5 world-vercel target (`lo = 6`) also needs an
   all-slot log. The run must actually have started. The initial arguments
   must be decodable by the target: framing and compression are chosen from
   `getRunCapabilities(probe.workflowCoreVersion)` (capabilities.ts:146-176,
   start.ts:538-542, 749-761); a miss or a plain-text reply leaves only the
   baseline format. The run's output must be decodable by the caller: a v5
   executor compresses once the run is at ≥ 5 (workflow.ts:1254 on main), and
   a stable caller cannot decode gzip (stable serialization-format.ts:58-87).

`Target.wf` encodes what the code guarantees about a target:
* a JSON responder reports `world.specVersion = mintedSpecVersion()`, which it
  can run (`lo ≤ reported ≤ hi`, helpers.ts:154-210 / world-vercel index.ts:42).
* plain text comes only from pre-3 deployments (`hi ≤ 2`, helpers.ts:328-330).
* JSON responders are ≥ 3.
* an attested version is a v5 mint (6, 7 or 8) that the target runs. Only a v5
  world-vercel executor attests (#4366), so an attesting target has `lo = 6`.
* a target has the v5 codecs (gzip, framing) iff `hi ≥ 5`.

## Results (every `theorem` below compiles)
Sequential abstraction (no concurrent starter), carried over from the first
version of this model:
* `answered_json_accepts`, `answered_overstamp_iff`, `miss_current_bricks_iff`,
  `miss_proposed_bricks_iff`, `miss_proposed_fixed_bricks_iff`,
  `malformed_*_bricks_iff`: the same statements as before, now named for what
  they are: statements about a single, non-concurrent `run_started`.
* `turbo_stale_conservative`, `raise_bounded`, `miss_current_runnable`,
  `miss_current_bricks_low`: unbounded, sequential.

Race-composed. `brickPossible` means some interleaving fails `fullOk`;
`brickCertain` means every interleaving does:
* `race_answered_json_ok`: an answered JSON probe is safe for every start()
  client in every interleaving, even on #1044 as written, because the stamp is
  ≥ 6 on every v5 world-vercel target, so no ULID is ever minted.
* `race_miss_current_iff`: #4327's miss floor 6 bricks exactly `hi < 6`, and
  certainly, in both server variants.
* `race_miss_proposed_asIs_iff`: with floor 3, #1044 as written can brick
  every v5 world-vercel target on EVERY start path, including fresh ones,
  through the stale-skip race. It is certain only without #4366.
* `race_miss_proposed_fixed_iff`: with every server fix, floor 3 bricks exactly
  `hi < 3 ∨ (3 < lo ∧ no attestation)`.
* `race_explicit_*`: an explicit stamp bricks iff it is out of range. With every
  fix, a stamp below `lo` is healed whenever the target attests and the stamp
  is not legacy (1).
* `race_replay_*`: a same-deployment replay, or a CLI replay, of a source run
  that was runnable is always fine. A replay of a bricked source (stamp below
  `lo`) re-bricks on #1044 in some interleaving; with the fixes it heals iff
  the target attests and the stamp is ≥ 2.
* `race_stable_caller_*`: a stable caller into a v5 world-vercel target never
  gets a usable result. Either the run bricks, or it is raised to ≥ 6 and the
  output is compressed where the caller cannot decode it. Into a stable target
  or a v5 local/postgres target it is fine.
* `race_args_decodable`: the caller never picks an argument format the target
  cannot decode.
* `race_outcomes_bounded`: in every interleaving, stamp ≤ final ≤ max(stamp, e).
-/
namespace CrossDeploy

structure Target where
  reply : Reply
  lo : Nat
  hi : Nat
  attest : Option Nat
deriving DecidableEq, Repr

def Target.wf (t : Target) : Bool :=
  decide (1 ≤ t.lo) && decide (t.lo ≤ 6) && decide (t.lo ≤ t.hi) &&
  (match t.reply with
   | .json r => decide (t.lo ≤ r) && decide (r ≤ t.hi)
   | .plaintext => decide (t.hi ≤ 2)
   | .jsonMalformed => decide (3 ≤ t.hi)) &&
  (match t.attest with
   | none => true
   | some e => decide (6 ≤ e) && t.lo == 6 && decide (e ≤ t.hi))

inductive StartPath where
  | fresh
  | runCreatedLate
  | resilient
deriving DecidableEq, Repr

/-- The first `run_started` (events.ts:8044-8053 calls the upgrade before any
other read of the run's version). -/
def firstDelivery (s : Nat) (attest : Option Nat) (path : StartPath) : Nat :=
  match attest, path with
  | none, _ => s
  | some _, .resilient => s
  | some e, .fresh =>
    (upgrade false ⟨s, .pending⟩ e (.runCreatedOnly (idKindFor s)) ⟨s, .pending⟩).run.spec
  | some e, .runCreatedLate =>
    (upgrade false ⟨s, .pending⟩ e .empty ⟨s, .pending⟩).run.spec

/-- A later `run_started` on the now-running run. -/
def redelivery (s : Nat) (attest : Option Nat) : Nat :=
  match attest with
  | none => s
  | some e => (upgrade false ⟨s, .running⟩ e (.runCreatedThenMore (idKindFor s)) ⟨s, .running⟩).run.spec

def serverRaise (s : Nat) (attest : Option Nat) (path : StartPath) (redeliver : Bool) : Nat :=
  if redeliver then redelivery (firstDelivery s attest path) attest else firstDelivery s attest path

inductive Client where
  /-- #4327 as written (miss floor 6, unversioned → 2) -/
  | current
  /-- proposed (miss floor 3, malformed JSON → 3, plain text → 2) -/
  | proposed
deriving DecidableEq, Repr

def stampOf : Client → Option ProbeObj → Nat → Nat
  | .current, p, c => resolve p c
  | .proposed, p, c => resolveProposed p c

def finalSpec (cl : Client) (t : Target) (net : Net) (c : Nat) (path : StartPath) (rd : Bool) : Nat :=
  serverRaise (stampOf cl (probeOf t.reply net) c) t.attest path rd

def accepts (t : Target) (s : Nat) : Bool := decide (t.lo ≤ s) && decide (s ≤ t.hi)

def healed (t : Target) (path : StartPath) : Bool := t.attest.isSome && path == .fresh

/-! ## Finite domains -/

def vers : List Nat := [1, 2, 3, 4, 5, 6, 7, 8, 9]
def replies : List Reply := .plaintext :: .jsonMalformed :: vers.map .json
def attests : List (Option Nat) := none :: vers.map some
def wfTargets : List Target :=
  (replies.flatMap fun r => vers.flatMap fun lo => vers.flatMap fun hi =>
    attests.map fun a => ({ reply := r, lo := lo, hi := hi, attest := a } : Target)).filter (·.wf)
/-- v5 callers: World spec ∈ [6, MAX]; 9 stands for a future version. -/
def callers : List Nat := [6, 7, 8, 9]
def nets : List Net := [.answered, .timeout, .noChannel]
def paths : List StartPath := [.fresh, .runCreatedLate, .resilient]
def clients : List Client := [.current, .proposed]
def bools : List Bool := [false, true]

/-- `∀` over every combination of the domain slice: clients `cls`, probe outcomes
`ns`, well-formed targets satisfying `tf`, every caller World, start path and
redelivery flag. -/
def forAllIn (cls : List Client) (ns : List Net) (tf : Target → Bool)
    (p : Client → Target → Net → Nat → StartPath → Bool → Bool) : Bool :=
  cls.all fun cl => (wfTargets.filter tf).all fun t => ns.all fun n => callers.all fun c =>
    paths.all fun pa => bools.all fun rd => p cl t n c pa rd

def misses : List Net := [.timeout, .noChannel]

def isJson : Reply → Bool
  | .json _ => true
  | _ => false

/-! ## Exhaustive checks, sequential server (kernel-evaluated `decide`) -/

/-- Sequential: the probe answers with a version ⇒ the run is runnable on every
start path and with a redelivery (no concurrent starter; see `race_answered_json_ok`). -/
def chkAnsweredJson : Bool := forAllIn clients [.answered] (isJson ·.reply) fun cl t n c pa rd =>
  accepts t (finalSpec cl t n c pa rd)

theorem answered_json_accepts : chkAnsweredJson = true := by decide +kernel

/-- With an answer, over-stamping happens only for plain text with `hi = 1`. -/
def chkAnsweredOverstamp : Bool := forAllIn clients [.answered] (fun _ => true) fun cl t n c pa rd =>
    (decide (t.hi < finalSpec cl t n c pa rd) == (t.reply == .plaintext && t.hi == 1))

theorem answered_overstamp_iff : chkAnsweredOverstamp = true := by decide +kernel

/-- Probe miss, #4327 as written: bricks ⟺ `hi < 6`. -/
def chkMissCurrent : Bool := forAllIn [.current] misses (fun _ => true) fun cl t n c pa rd =>
    (!accepts t (finalSpec cl t n c pa rd) == decide (t.hi < 6))

theorem miss_current_bricks_iff : chkMissCurrent = true := by decide +kernel

/-- Probe miss, proposed floor 3 + raise: bricks ⟺ `hi < 3 ∨ (3 < lo ∧ ¬healed)`. -/
def chkMissProposed : Bool := forAllIn [.proposed] misses (fun _ => true) fun cl t n c pa rd =>
    (!accepts t (finalSpec cl t n c pa rd) ==
      (decide (t.hi < 3) || (decide (3 < t.lo) && !healed t pa)))

theorem miss_proposed_bricks_iff : chkMissProposed = true := by decide +kernel

/-- Malformed JSON version, current (→ 2): bricks ⟺ `2 < lo ∧ ¬healed`. -/
def chkMalformedCurrent : Bool :=
  forAllIn [.current] [.answered] (·.reply == .jsonMalformed) fun cl t n c pa rd =>
    (!accepts t (finalSpec cl t n c pa rd) == (decide (2 < t.lo) && !healed t pa))

theorem malformed_current_bricks_iff : chkMalformedCurrent = true := by decide +kernel

/-- Malformed JSON version, proposed (→ 3): bricks ⟺ `3 < lo ∧ ¬healed`. -/
def chkMalformedProposed : Bool :=
  forAllIn [.proposed] [.answered] (·.reply == .jsonMalformed) fun cl t n c pa rd =>
    (!accepts t (finalSpec cl t n c pa rd) == (decide (3 < t.lo) && !healed t pa))

theorem malformed_proposed_bricks_iff : chkMalformedProposed = true := by decide +kernel

/-- PROPOSED server fixes (modelled in `CrossDeploy.StaleSkip`): a head read that
finds no `run_created` fails retryably instead of skipping, and the
resilient-start creation applies the attested version (its log is fresh by
construction). Both make every first run_started behave like `fresh`. -/
def serverRaiseFixed (s : Nat) (attest : Option Nat) (_path : StartPath) (rd : Bool) : Nat :=
  serverRaise s attest .fresh rd

/-- With those fixes, floor 3 + raise bricks exactly the pre-3 targets and the
v5 world-vercel targets that do not attest (no #4366). -/
def chkMissProposedFixed : Bool := forAllIn [.proposed] misses (fun _ => true) fun cl t n c pa rd =>
  (!accepts t (serverRaiseFixed (stampOf cl (probeOf t.reply n) c) t.attest pa rd) ==
    (decide (t.hi < 3) || (decide (3 < t.lo) && t.attest.isNone)))

theorem miss_proposed_fixed_bricks_iff : chkMissProposedFixed = true := by decide +kernel

/-! ## General (unbounded) theorems for the miss path -/

theorem serverRaise_ge (s : Nat) (a : Option Nat) (pa : StartPath) (rd : Bool) :
    s ≤ serverRaise s a pa rd := by
  have h1 : s ≤ firstDelivery s a pa := by
    unfold firstDelivery
    split
    · exact Nat.le_refl _
    · exact Nat.le_refl _
    · exact upgrade_never_lowers false ⟨s, .pending⟩ ⟨s, .pending⟩ _ _ (Nat.le_refl _)
    · exact upgrade_never_lowers false ⟨s, .pending⟩ ⟨s, .pending⟩ _ _ (Nat.le_refl _)
  unfold serverRaise
  split
  · refine Nat.le_trans h1 ?_
    unfold redelivery; split
    · exact Nat.le_refl _
    · exact upgrade_never_lowers false ⟨_, .running⟩ ⟨_, .running⟩ _ _ (Nat.le_refl _)
  · exact h1

theorem serverRaise_le (s : Nat) (a : Option Nat) (pa : StartPath) (rd : Bool) :
    serverRaise s a pa rd ≤ max s (a.getD 0) := by
  have h1 : firstDelivery s a pa ≤ max s (a.getD 0) := by
    unfold firstDelivery
    split
    · omega
    · omega
    · rename_i e; have := upgrade_le_max false ⟨s, .pending⟩ e (.runCreatedOnly (idKindFor s)); simp at this ⊢; omega
    · rename_i e; have := upgrade_le_max false ⟨s, .pending⟩ e .empty; simp at this ⊢; omega
  unfold serverRaise
  split
  · unfold redelivery; split
    · simp at h1 ⊢; omega
    · rename_i e
      have := upgrade_le_max false ⟨firstDelivery s (some e) pa, .running⟩ e
        (.runCreatedThenMore (idKindFor (firstDelivery s (some e) pa)))
      simp at this h1 ⊢; omega
  · exact h1

/-- Turbo's first invocation runs on the stamp (the synthesized run carries
`runInput.specVersion`, runtime.ts:2506-2600), which is never above the persisted
version; and the server never goes above the attested version. So every `≥ k`
capability gate evaluated on the stale copy is only ever under-enabled
(compression ≥ 5 runtime.ts:424; batch fan-out ≥ 6 suspension-handler.ts:1050-1070). -/
theorem turbo_stale_conservative (cl : Client) (t : Target) (n : Net) (c : Nat) (pa : StartPath) (rd : Bool) :
    stampOf cl (probeOf t.reply n) c ≤ finalSpec cl t n c pa rd ∧
    finalSpec cl t n c pa rd ≤ max (stampOf cl (probeOf t.reply n) c) (t.attest.getD 0) :=
  ⟨serverRaise_ge _ _ _ _, serverRaise_le _ _ _ _⟩

theorem turbo_gate_conservative (cl : Client) (t : Target) (n : Net) (c : Nat) (pa : StartPath) (rd : Bool)
    (k : Nat) (h : k ≤ stampOf cl (probeOf t.reply n) c) : k ≤ finalSpec cl t n c pa rd :=
  Nat.le_trans h (turbo_stale_conservative cl t n c pa rd).1

/-- The raise never produces a version the target cannot run when the stamp did
not already exceed it: `stamp ≤ hi → final ≤ hi` (a persisted 8 — which unlocks
force-claim, version-utils.ts:166-167 — therefore always sits on a target whose
code reads `forceClaimedBy`). -/
theorem raise_bounded (t : Target) (ht : t.wf = true) (s : Nat) (hs : s ≤ t.hi) (pa : StartPath) (rd : Bool) :
    serverRaise s t.attest pa rd ≤ t.hi := by
  have hle := serverRaise_le s t.attest pa rd
  have : t.attest.getD 0 ≤ t.hi := by
    unfold Target.wf at ht
    cases h : t.attest with
    | none => simp
    | some e => simp_all <;> omega
  omega

/-- Unbounded version of the current miss result: for any v5 caller the stamp is 6,
and 6 is runnable on every target with `lo ≤ 6 ≤ hi` whatever the server does. -/
theorem miss_current_runnable (t : Target) (c : Nat) (hc : 6 ≤ c) (hlo : t.lo ≤ 6) (hhi : 6 ≤ t.hi)
    (hatt : ∀ e, t.attest = some e → e ≤ t.hi)
    (n : Net) (hn : n ≠ .answered) (pa : StartPath) (rd : Bool) :
    accepts t (finalSpec .current t n c pa rd) = true := by
  have hs : stampOf .current (probeOf t.reply n) c = 6 := by
    cases n with
    | answered => exact absurd rfl hn
    | timeout => exact (resolve_miss_v5 hc).2
    | noChannel => exact (resolve_miss_v5 hc).1
  unfold finalSpec accepts
  rw [hs]
  have hge := serverRaise_ge 6 t.attest pa rd
  have hle := serverRaise_le 6 t.attest pa rd
  have : t.attest.getD 0 ≤ t.hi := by
    cases h : t.attest with
    | none => simp
    | some e => simpa using hatt e h
  simp; omega

/-- Unbounded: a miss against a target with `hi < 6` bricks under #4327 (the
target never attests above its own max). -/
theorem miss_current_bricks_low (t : Target) (c : Nat) (hc : 6 ≤ c) (hhi : t.hi < 6)
    (hatt : ∀ e, t.attest = some e → e ≤ t.hi)
    (n : Net) (hn : n ≠ .answered) (pa : StartPath) (rd : Bool) :
    accepts t (finalSpec .current t n c pa rd) = false := by
  have hs : stampOf .current (probeOf t.reply n) c = 6 := by
    cases n with
    | answered => exact absurd rfl hn
    | timeout => exact (resolve_miss_v5 hc).2
    | noChannel => exact (resolve_miss_v5 hc).1
  unfold finalSpec accepts
  rw [hs]
  have hge := serverRaise_ge 6 t.attest pa rd
  have hle := serverRaise_le 6 t.attest pa rd
  have : t.attest.getD 0 ≤ t.hi := by
    cases h : t.attest with
    | none => simp
    | some e => simpa using hatt e h
  simp; omega

/-! ## Named profiles -/

/-- pre-spec-3 deployment (plain-text health reply). -/
def pre3 : Target := ⟨.plaintext, 1, 2, none⟩
/-- origin/stable (v4): JSON 3, max 3, no executorSpecVersion. -/
def stable : Target := ⟨.json 3, 1, 3, none⟩
/-- #4327 head alone (not rebased on #4193, no #4366): mints 7, max 7. -/
def v5head : Target := ⟨.json 7, 6, 7, none⟩
/-- #4327 head with WORKFLOW_SEALED_LOG=0: mints 6, max 7. -/
def v5headKill : Target := ⟨.json 6, 6, 7, none⟩
/-- main (#4193) + #4366 on world-vercel: mints and attests 8. -/
def v5main : Target := ⟨.json 8, 6, 8, some 8⟩
/-- main + #4366, WORKFLOW_SEALED_LOG=0: reports and attests 6. -/
def v5mainKill : Target := ⟨.json 6, 6, 8, some 6⟩
/-- main + #4366, responder captured 8 at createWorld but the executor's env now mints 6. -/
def v5mainSplit : Target := ⟨.json 8, 6, 8, some 6⟩
/-- a main deployment built before #4366 (no attestation). -/
def v5mainPre4366 : Target := ⟨.json 8, 6, 8, none⟩
/-- v5 on world-local / world-postgres: slot ids regardless of stamp; ignores executorSpecVersion. -/
def v5local : Target := ⟨.json 8, 1, 8, none⟩

def profiles : List (String × Target) :=
  [("pre3", pre3), ("stable", stable), ("v5head", v5head), ("v5headKill", v5headKill),
   ("v5main", v5main), ("v5mainKill", v5mainKill), ("v5mainSplit", v5mainSplit),
   ("v5mainPre4366", v5mainPre4366), ("v5local", v5local)]

theorem profiles_wf : profiles.all (fun p => p.2.wf) = true := by decide

/-! ### Stable caller into a v5 target (the case #1044 exists for), sequential -/

/-- Sequential: a stable caller stamps 3 (stable start.ts:248-252; no probe of the
version). Into main + #4366, with a single run_started, it heals iff that is on the
fresh path. With concurrent starters the fresh path can brick too, and a healed run's
output is undecodable by the stable caller: see `race_stable_caller_into_v5wv`. -/
theorem stable_caller_into_v5main :
    paths.all (fun pa => bools.all fun rd =>
      accepts v5main (serverRaise 3 v5main.attest pa rd) == (pa == .fresh)) = true := by
  decide

/-- Into a v5 deployment without #4366 it always bricks. -/
theorem stable_caller_into_v5_pre4366 :
    paths.all (fun pa => bools.all fun rd =>
      !accepts v5mainPre4366 (serverRaise 3 v5mainPre4366.attest pa rd) &&
      !accepts v5head (serverRaise 3 v5head.attest pa rd)) = true := by
  decide

/-- Whenever that run is runnable it is ≥ 5, so the v5 executor compresses its
output (compression gate ≥ 5, workflow.ts:1254 on main), which the stable caller's
`Run.returnValue` cannot decode ('Unknown serialization format',
stable serialization-format.ts:58-87). -/
theorem stable_caller_healed_run_is_compressed :
    paths.all (fun pa => bools.all fun rd =>
      !accepts v5main (serverRaise 3 v5main.attest pa rd) ||
        decide (5 ≤ serverRaise 3 v5main.attest pa rd)) = true := by
  decide

/-! ### Explicit `opts.specVersion`, recreate, CLI: sequential witnesses (the exhaustive race-composed versions are `race_explicit_iff`, `race_replay_*`) -/

/-- `opts.specVersion` wins uncapped (start.ts:587-588): an explicit 6 into stable,
or an explicit 3 into a non-attesting v5 target, bricks even though the probe
would have answered. -/
theorem explicit_can_brick :
    accepts stable (serverRaise 6 stable.attest .fresh false) = false ∧
    accepts v5mainPre4366 (serverRaise 3 v5mainPre4366.attest .fresh false) = false ∧
    accepts v5main (serverRaise 3 v5main.attest .runCreatedLate true) = false := by
  decide

/-- CLI `startRun` (cli/src/lib/inspect/run.ts:87-109): `min(hc.specVersion,
world.specVersion)` only for a healthy reply with a numeric version, else the
source run's version, uncapped. -/
def cliStamp (p : Option ProbeObj) (runSpec c : Nat) : Nat :=
  match p with
  | some o =>
    if o.healthy then
      match o.spec with
      | .int n => min n.toNat c
      | _ => runSpec
    else runSpec
  | none => runSpec

/-- The CLI replays onto the source run's own deployment, so when the source run
was runnable there (`runSpec ≤ hi`) the CLI stamp is too — on every probe outcome. -/
theorem cli_le_hi (t : Target) (ht : t.wf = true) (runSpec c : Nat) (hr : runSpec ≤ t.hi) (n : Net) :
    cliStamp (probeOf t.reply n) runSpec c ≤ t.hi := by
  unfold Target.wf at ht
  cases n <;> simp [probeOf, cliStamp] <;> (try omega)
  cases hrep : t.reply <;> simp_all <;> omega

/-- ...but a JSON `specVersion: 0` would stamp 0 via the CLI (no `>= 1` check),
where `start()` would have treated it as unversioned (2). No in-repo responder
sends 0. -/
theorem cli_zero_version : cliStamp (some ⟨true, .int 0, false⟩) 8 8 = 0 ∧
    resolve (some ⟨true, .int 0, false⟩) 8 = 2 := by decide


/-! ## Report tables (printed into results/Combined.txt) -/

def netName : Net → String
  | .answered => "answered"
  | .timeout => "timeout"
  | .noChannel => "no-channel"

def pathName : StartPath → String
  | .fresh => "fresh"
  | .runCreatedLate => "run_created-late"
  | .resilient => "resilient"

def clientName : Client → String
  | .current => "current(#4327)"
  | .proposed => "proposed(floor3)"

/-! ## Race-composed pipeline -/

inductive Client2 where
  /-- `start()` at #4327 (probe; miss floor 6, unversioned → 2) -/
  | current
  /-- `start()` with the proposed floor 3 / malformed → 3 -/
  | proposed
  /-- `opts.specVersion = v`, uncapped (start.ts:587-588) -/
  | explicit (v : Nat)
  /-- `recreateRunFromExisting` onto the source run's own deployment: `run.specVersion ?? 1` explicit (runs.ts:83-130) -/
  | recreateSame (runSpec : Option Nat)
  /-- `recreateRunFromExisting` onto another deployment: unset → `start()`'s probe -/
  | recreateRedirect
  /-- CLI `startRun` (cli/src/lib/inspect/run.ts:87-109) -/
  | cli (runSpec : Option Nat)
  /-- a stable (v4) caller: `opts.specVersion ?? world.specVersion` = 3 (stable start.ts:248-252) -/
  | stableCaller
deriving DecidableEq, Repr

/-- CLI: `min(hc.specVersion, world.specVersion)` for a healthy numeric reply,
else the source run's (possibly unset) version. -/
def cliStampOpt (p : Option ProbeObj) (rs : Option Nat) (c : Nat) : Option Nat :=
  match p with
  | some o =>
    if o.healthy then
      match o.spec with
      | .int n => some (min n.toNat c)
      | _ => rs
    else rs
  | none => rs

def stampOf2 : Client2 → Option ProbeObj → Nat → Nat
  | .current, p, c => resolve p c
  | .proposed, p, c => resolveProposed p c
  | .explicit v, _, _ => v
  | .recreateSame rs, _, _ => rs.getD 1
  | .recreateRedirect, p, c => resolve p c
  | .cli rs, p, c => (cliStampOpt p rs c).getD (resolve p c)
  | .stableCaller, _, _ => 3

def pathC0 : StartPath → Nat
  | .fresh => 2
  | .runCreatedLate => 1
  | .resilient => 0

def pathIdx : StartPath → Nat
  | .fresh => 0
  | .runCreatedLate => 1
  | .resilient => 2

/-- A quiescent outcome of the concurrent model: (row spec, all ids slots, status). -/
abbrev Out := Nat × Bool × Option Status

def raceOutRaw (cfg : Race.Cfg) (s : Nat) (a : Option Nat) (pa : StartPath) : List Out :=
  (Race.explore cfg { stamp := s, es := [a, a], c0 := pathC0 pa } false).outcomes

def tblIdx (s : Nat) (a : Option Nat) (pa : StartPath) : Nat := (s * 10 + a.getD 0) * 3 + pathIdx pa

/-- Memo table over stamps 1..9, attestations none/6..9 and the three paths. -/
def buildTable (cfg : Race.Cfg) : Array (List Out) :=
  ((List.range 300).map fun k =>
    let pi := k % 3
    let sa := k / 3
    let s := sa / 10
    let a := sa % 10
    let pa := if pi == 0 then StartPath.fresh else if pi == 1 then .runCreatedLate else .resilient
    if 1 ≤ s && (a == 0 || 6 ≤ a) then raceOutRaw cfg s (if a == 0 then none else some a) pa else []).toArray

def tblAsIs : Array (List Out) := buildTable Race.asIs
def tblFix : Array (List Out) := buildTable Race.allFixes

inductive Srv where
  | asIs
  | fixed
deriving DecidableEq, Repr

def raceOut (sv : Srv) (s : Nat) (a : Option Nat) (pa : StartPath) : List Out :=
  let inTable := decide (1 ≤ s) && decide (s ≤ 9) && (a.isNone || decide (6 ≤ a.getD 0) && decide (a.getD 0 ≤ 9))
  if inTable then
    (match sv with | .asIs => tblAsIs | .fixed => tblFix)[tblIdx s a pa]?.getD []
  else raceOutRaw (match sv with | .asIs => Race.asIs | .fixed => Race.allFixes) s a pa

/-- The target has the v5 codecs (gzip/zstd, byte-stream framing) iff it runs spec ≥ 5. -/
def Target.v5core (t : Target) : Bool := decide (5 ≤ t.hi)

/-- The caller learns the target's core version only from an answered JSON
reply (plain text carries no `workflowCoreVersion`; a miss leaves it undefined →
baseline formats, capabilities.ts:149-154). -/
def learnedV5 (t : Target) (n : Net) : Bool := n == .answered && t.reply != .plaintext && t.v5core

/-- Initial arguments: framing iff learned; compression iff learned and stamp ≥ 5
(start.ts:749-761). The target must decode what was chosen. -/
def argsDecodable (t : Target) (n : Net) (s : Nat) : Bool :=
  let framing := learnedV5 t n
  let comp := learnedV5 t n && decide (5 ≤ s)
  (!framing || t.v5core) && (!comp || t.v5core)

/-- The run's output: a v5 executor compresses once the run is at ≥ 5; only a
stable caller cannot decode it. -/
def outputDecodable (cl : Client2) (t : Target) (final : Nat) : Bool :=
  !(t.v5core && decide (5 ≤ final)) || cl != .stableCaller

/-- A quiescent outcome is usable iff the version is in range; the log is all
slots whenever the target needs them (`lo = 6`) or the run sits at ≥ 6 (a ULID in
a slot-mode log is a server-side 500 for any SDK, event-slot-identity.ts:171-193);
the run started; and both payload directions decode. -/
def outOk (cl : Client2) (t : Target) (n : Net) (s : Nat) (o : Out) : Bool :=
  accepts t o.1 && (!(decide (6 ≤ t.lo) || decide (6 ≤ o.1)) || o.2.1) && o.2.2 == some .running &&
  argsDecodable t n s && outputDecodable cl t o.1

def outcomesOf (sv : Srv) (cl : Client2) (t : Target) (n : Net) (c : Nat) (pa : StartPath) : List Out :=
  raceOut sv (stampOf2 cl (probeOf t.reply n) c) t.attest pa

def brickPossible (sv : Srv) (cl : Client2) (t : Target) (n : Net) (c : Nat) (pa : StartPath) : Bool :=
  let s := stampOf2 cl (probeOf t.reply n) c
  (outcomesOf sv cl t n c pa).any (!outOk cl t n s ·)

def brickCertain (sv : Srv) (cl : Client2) (t : Target) (n : Net) (c : Nat) (pa : StartPath) : Bool :=
  let s := stampOf2 cl (probeOf t.reply n) c
  (outcomesOf sv cl t n c pa).all (!outOk cl t n s ·)

def runSpecs : List (Option Nat) := none :: vers.map some
def srvs : List Srv := [.asIs, .fixed]

def forAll2 (cls : List Client2) (ns : List Net) (tf : Target → Bool)
    (p : Client2 → Target → Net → Nat → StartPath → Bool) : Bool :=
  cls.all fun cl => (wfTargets.filter tf).all fun t => ns.all fun n => callers.all fun c =>
    paths.all fun pa => p cl t n c pa

def probeClients : List Client2 := [.current, .proposed, .recreateRedirect]

/-- Every quiescent outcome exists (the explorer found at least one) — guards
the ∀-style checks below against vacuity. -/
theorem race_outcomes_nonempty :
    ([1, 2, 3, 4, 5, 6, 7, 8, 9].all fun s => [none, some 6, some 7, some 8, some 9].all fun a =>
      paths.all fun pa => srvs.all fun sv => !(raceOut sv s a pa).isEmpty) = true := by native_decide

/-- In every interleaving the persisted version stays in [stamp, max(stamp, e)]. -/
theorem race_outcomes_bounded :
    ([1, 2, 3, 4, 5, 6, 7, 8, 9].all fun s => [none, some 6, some 7, some 8, some 9].all fun a =>
      paths.all fun pa => srvs.all fun sv =>
        (raceOut sv s a pa).all fun o => decide (s ≤ o.1) && decide (o.1 ≤ max s (a.getD 0))) = true := by
  native_decide

/-- An answered JSON probe: safe for every start()-probing client, in every
interleaving, on #1044 as written and with the fixes. -/
theorem race_answered_json_ok :
    (srvs.all fun sv => forAll2 probeClients [.answered] (isJson ·.reply) fun cl t n c pa =>
      !brickPossible sv cl t n c pa) = true := by native_decide

/-- Answered plain text / malformed: bricks only as in the sequential model (plain
text with `hi = 1`; malformed JSON below `lo` unless healed). -/
theorem race_answered_plaintext_iff :
    (srvs.all fun sv => forAll2 probeClients [.answered] (·.reply == .plaintext) fun cl t n c pa =>
      brickPossible sv cl t n c pa == (t.hi == 1)) = true := by native_decide

/-- #4327's miss floor 6: bricks exactly `hi < 6`, certainly, in both server variants. -/
theorem race_miss_current_iff :
    (srvs.all fun sv => forAll2 [.current, .recreateRedirect] misses (fun _ => true) fun cl t n c pa =>
      brickPossible sv cl t n c pa == decide (t.hi < 6) &&
      brickCertain sv cl t n c pa == decide (t.hi < 6)) = true := by native_decide

/-- Floor 3 on #1044 as written: some interleaving bricks every v5 world-vercel
target on every path (the stale-skip race), certainly only without #4366. -/
theorem race_miss_proposed_asIs_iff :
    forAll2 [.proposed] misses (fun _ => true) (fun cl t n c pa =>
      brickPossible .asIs cl t n c pa == (decide (t.hi < 3) || decide (3 < t.lo)) &&
      brickCertain .asIs cl t n c pa == (decide (t.hi < 3) || (decide (3 < t.lo) && t.attest.isNone))) = true := by
  native_decide

/-- Floor 3 with every proposed server fix: bricks exactly pre-3 targets and v5
world-vercel targets that do not attest, on every path, in every interleaving. -/
theorem race_miss_proposed_fixed_iff :
    forAll2 [.proposed] misses (fun _ => true) (fun cl t n c pa =>
      brickPossible .fixed cl t n c pa == (decide (t.hi < 3) || (decide (3 < t.lo) && t.attest.isNone)) &&
      brickCertain .fixed cl t n c pa == brickPossible .fixed cl t n c pa) = true := by
  native_decide

/-- Malformed JSON version. -/
theorem race_malformed_iff :
    (forAll2 [.current] [.answered] (·.reply == .jsonMalformed) fun cl t n c pa =>
      brickPossible .asIs cl t n c pa == decide (2 < t.lo) &&
      brickPossible .fixed cl t n c pa == (decide (2 < t.lo) && t.attest.isNone)) &&
    (forAll2 [.proposed] [.answered] (·.reply == .jsonMalformed) fun cl t n c pa =>
      brickPossible .asIs cl t n c pa == decide (3 < t.lo) &&
      brickPossible .fixed cl t n c pa == (decide (3 < t.lo) && t.attest.isNone)) = true := by
  native_decide

/-- Explicit `opts.specVersion = v`, every probe outcome. On #1044: bricks
(possibly) iff out of range; with the fixes: iff above `hi`, or below `lo`
without attestation or at legacy 1. -/
theorem race_explicit_iff :
    forAll2 (vers.map .explicit) nets (fun _ => true) (fun cl t n c pa =>
      let v := stampOf2 cl none 0
      brickPossible .asIs cl t n c pa == !(decide (t.lo ≤ v) && decide (v ≤ t.hi)) &&
      brickCertain .asIs cl t n c pa == (decide (t.hi < v) || (decide (v < t.lo) && (t.attest.isNone || v == 1))) &&
      brickPossible .fixed cl t n c pa == (decide (t.hi < v) || (decide (v < t.lo) && (t.attest.isNone || v == 1))) &&
      brickCertain .fixed cl t n c pa == brickPossible .fixed cl t n c pa) = true := by
  native_decide

/-- A same-deployment or CLI replay of a source run that was runnable on the
target (`lo ≤ runSpec ≤ hi`) never bricks, on any probe outcome, in any
interleaving, on either server. -/
theorem race_replay_runnable_ok :
    (srvs.all fun sv => forAll2 (runSpecs.filterMap fun rs => rs.map fun v => Client2.recreateSame (some v)) nets
      (fun _ => true) fun cl t n c pa =>
        let v := stampOf2 cl none 0
        !(decide (t.lo ≤ v) && decide (v ≤ t.hi)) || !brickPossible sv cl t n c pa) &&
    (srvs.all fun sv => forAll2 (vers.map fun v => Client2.cli (some v)) nets (fun _ => true) fun cl t n c pa =>
        let v := match cl with | .cli (some v) => v | _ => 0
        !(decide (t.lo ≤ v) && decide (v ≤ t.hi)) || !brickPossible sv cl t n c pa) = true := by
  native_decide

/-- Replaying a bricked source (stamp below `lo`, e.g. a stable caller's 3 on a
v5 world-vercel target) re-bricks on #1044 in some interleaving (always when the
CLI's probe does not answer with a version); with the fixes it heals iff the
target attests and the stamp is not legacy. -/
theorem race_replay_bricked :
    forAll2 (vers.map fun v => Client2.recreateSame (some v)) nets (fun _ => true) (fun cl t n c pa =>
      let v := stampOf2 cl none 0
      !decide (v < t.lo) ||
        (brickPossible .asIs cl t n c pa &&
         brickPossible .fixed cl t n c pa == (t.attest.isNone || v == 1))) = true := by
  native_decide

/-- `recreateRunFromExisting` of a run with no stored version replays at legacy 1:
fine on a target that runs 1, bricks on every v5 world-vercel target. -/
theorem race_recreate_unset_is_legacy :
    (srvs.all fun sv => forAll2 [.recreateSame none] nets (fun _ => true) fun cl t n c pa =>
      brickPossible sv cl t n c pa == decide (1 < t.lo)) = true := by native_decide

/-- A stable caller into a v5 world-vercel target never gets a usable result
(bricked, or raised ≥ 6 and its output compressed beyond what it decodes). -/
theorem race_stable_caller_into_v5wv :
    (srvs.all fun sv => forAll2 [.stableCaller] nets (fun t => t.lo == 6) fun cl t n c pa =>
      brickCertain sv cl t n c pa) = true := by native_decide

/-- ...while into a target that runs 3 without raising it (stable, v5 local/postgres) it is fine. -/
theorem race_stable_caller_ok_iff :
    (srvs.all fun sv => forAll2 [.stableCaller] nets (fun t => t.lo ≤ 3 && 3 ≤ t.hi && t.attest.isNone) fun cl t n c pa =>
      !brickPossible sv cl t n c pa) = true := by native_decide

/-- The caller never picks an argument format the target cannot decode. -/
theorem race_args_decodable :
    forAll2 ([.current, .proposed, .recreateRedirect, .stableCaller] ++ vers.map .explicit ++
      runSpecs.map .cli ++ runSpecs.map .recreateSame) nets (fun _ => true) (fun cl t n c _ =>
        argsDecodable t n (stampOf2 cl (probeOf t.reply n) c)) = true := by native_decide

/-! ### Race-composed profile table -/

def client2Name : Client2 → String
  | .current => "current(#4327)"
  | .proposed => "proposed(floor3)"
  | .explicit v => s!"explicit({v})"
  | .recreateSame rs => s!"recreateSame({match rs with | some v => toString v | none => "unset"})"
  | .recreateRedirect => "recreateRedirect"
  | .cli rs => s!"cli(run spec {match rs with | some v => toString v | none => "unset"})"
  | .stableCaller => "stableCaller"

def verdict (sv : Srv) (cl : Client2) (t : Target) (n : Net) (c : Nat) (pa : StartPath) : String :=
  if brickCertain sv cl t n c pa then "BRICK"
  else if brickPossible sv cl t n c pa then "BRICK-possible"
  else "ok"

def table2 (c : Nat) : List String :=
  profiles.flatMap fun (nm, t) =>
    [Client2.current, .proposed, .stableCaller, .cli (some 3)].flatMap fun cl => nets.flatMap fun n =>
      paths.map fun pa =>
        let s := stampOf2 cl (probeOf t.reply n) c
        let fa := (raceOut .asIs s t.attest pa).map (·.1) |>.eraseDups
        let ff := (raceOut .fixed s t.attest pa).map (·.1) |>.eraseDups
        s!"{nm} | {client2Name cl} | {netName n} | {pathName pa} | stamp={s} | #1044 finals={fa} {verdict .asIs cl t n c pa} | fixed finals={ff} {verdict .fixed cl t n c pa}"


def table (c : Nat) : List String :=
  profiles.flatMap fun (nm, t) => clients.flatMap fun cl => nets.flatMap fun n =>
    paths.map fun pa =>
      let s := stampOf cl (probeOf t.reply n) c
      let f := finalSpec cl t n c pa false
      s!"{nm} | {clientName cl} | {netName n} | {pathName pa} | stamp={s} final={f} | " ++
        (if accepts t f then "ok" else "BRICK")

#eval IO.println s!"well-formed targets in the exhaustive domain: {wfTargets.length}"
#eval IO.println s!"combinations in the full domain (clients x targets x probe outcomes x caller Worlds x start paths x redelivery): {wfTargets.length * clients.length * nets.length * callers.length * paths.length * bools.length}"
#eval do
  IO.println "SEQUENTIAL server: profile | client | probe | start path | stamp/final (caller World 8, no redelivery) | verdict"
  for l in table 8 do IO.println l
#eval do
  IO.println "RACE-COMPOSED (2 concurrent starters of the target + client run_created; caller World 8)"
  IO.println "profile | client | probe | start path | stamp | #1044 as written: final versions reachable, verdict | all fixes: final versions, verdict"
  for l in table2 8 do IO.println l

end CrossDeploy
