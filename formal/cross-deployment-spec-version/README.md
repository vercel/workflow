# Formal models: cross-deployment spec-version stamping and raising

This directory holds TLA+ and Lean models of the fix stack for
[vercel/workflow#4251](https://github.com/vercel/workflow/issues/4251).
In that bug, a run started into another deployment could be stamped with a
spec version the target cannot run, and the run bricked.

The stack under test:

| PR | Side | What it does |
|---|---|---|
| [vercel/workflow#4327](https://github.com/vercel/workflow/pull/4327) | client (`@workflow/core` `start.ts`, `runs.ts`, CLI) | A cross-deployment `start()` stamps `min(probed target specVersion, caller world.specVersion)`. A plain-text probe reply stamps 2; a probe miss or a missing probe channel stamps 6. An explicit `opts.specVersion` wins. The probe budget is 10 s. A redirected replay leaves `specVersion` unset. `wf inspect` caps the replay stamp at its World. |
| [vercel/workflow#4366](https://github.com/vercel/workflow/pull/4366) | executor (`world-vercel`) | Every `run_started` carries `executorSpecVersion = mintedSpecVersion()` in its frame meta. That is 8 on main, or 6 with `WORKFLOW_SEALED_LOG=0`. |
| [vercel/workflow-server#1044](https://github.com/vercel/workflow-server/pull/1044) | backend | On `run_started`, if `executorSpecVersion > run.specVersion` and the run is not terminal, raise the run to that version in one conditional transaction. Crossing 6 (slot identity: re-key `run_created` from a ULID to slot 1) or 7 (sealed log) requires `status = pending` and a log of exactly `[run_created]`. |

The models check every state and version transition across the client, the
executor and the server that these PRs touch. They look for runs that can
brick (never run, or fail terminally), corrupt their log, lose their result,
or move backwards. They also check the proposed fixes and show which fixes
are necessary.

Code versions modelled: workflow `764eafd1a` (#4327 head), `origin/main`
(with #4193: `SPEC_VERSION_CURRENT = SPEC_VERSION_MAX_SUPPORTED = 8`,
hook force-claim), `origin/stable` (v4, mints 3, max 3),
`origin/peter/executor-spec-version` (#4366), and workflow-server `d0575db`
(#1044 head). The line references in each model point into those trees.

## The protocol in brief

```
 caller (start / replay / CLI)        workflow-server (#1044)           target deployment (executor)
 ─────────────────────────────        ───────────────────────           ────────────────────────────
 1. health probe (<= 10 s) ──────────────────────────────────────────▶ reply {specVersion: its mint}
                                                                       (pre-spec-3: plain text)
 2. stamp = opts.specVersion
          ?? min(probe, caller World)
      plain text -> 2, miss/no channel -> 6
 3. run_created(spec = stamp) ──────▶ run row (pending, spec)
                                      then run_created event row
    queue message (runInput.spec) ───────────────────────────────────▶
                                                                       4. run_started
                                      ◀──────────────────────────────── meta.executorSpecVersion
                                                                          = mintedSpecVersion() (#4366)
                                      5. raise if exec > spec, not terminal;
                                         crossing 6 or 7 needs pending and
                                         log == [run_created]; one tx:
                                         spec := exec, re-key run_created -> slot 1
                                         (skips: not-newer, terminal, log-not-fresh,
                                          run-created-not-committed, run-created-not-first)
                                      6. number run_started by the run's spec
                                         (< 6: ULID, >= 6: slot, >= 7: sequencer)
                                                                       7. replay: a v5 runtime on
                                                                          world-vercel requires slot
                                                                          ids (requireEventSlot)
 8. Run.returnValue ◀──────────────── output (compressed iff the executor's
                                      in-memory spec >= 5)
```

Version landmarks: 2 event sourcing, 3 CBOR queue transport, 4 attributes,
5 compression, 6 slot identity, 7 sealed log, 8 hook force-claim.

## Models

Each model directory has its own `run.sh`, and `results/` holds one TLC or
Lean output per check.

### StartStamping (TLA+): the whole start pipeline for one run

`StartStamping/StartStamping.tla`. Two layers in one state machine:

- **Layer A (stamp).** It enumerates 19,420 scenarios across these dimensions:
  - callers: stable, beta-4, beta-7, #4327 head, main with sealed log off, main
  - targets: pre-3 plain text, stable, beta-4, beta-5, beta-7 (no #4366),
    main with sealed log off, main, and a hypothetical 9
  - world: vercel or local/postgres
  - start kind: same, cross, latest-other, dashboard replay (same deployment
    or redirected), CLI
  - probe outcome: fast, slow (2 to 10 s), miss, no channel
  - attributes, and an explicit or source spec in `{unset, 1..9}`

  It has eight pure invariants (for example `NoOverStamp`, `CallerCap`,
  `StampRunnable`, `AttributesGateCorrect`, `TargetCanReadInput`). The ASSUME
  block prints every violating class per caller group.
- **Layer B (one run over shared server state).** The processes are:
  - the caller's two-write `run_created`, which can fail retryably and fall
    back to resilient start
  - two queue deliveries, each running the #1044 check, head read,
    transaction and reread, then the unconditional `running` patch and the
    `run_started` insert
  - replay, completion, and the compression decision
  - an optional `run_cancelled` racer
  - an optional crash plus the v4 missing-run-event recovery

  Invariants: `NoAvoidableBrick`, `NoMixedIdentityLog`, `NoResurrect`,
  `SpecNeverLowered`, `SingleRunCreated`, `NoOverRaise` (non-vacuous: the
  mutant `m` violates it) and `CallerCanReadResult`.
- **Variants.** Nine are built from a, b, c, ... Of note:
  - a = main before #4327
  - b = #4327
  - c = #4327 + #4366 + #1044 as written
  - d/e = the TODO's proposed miss floor of 3 with a 2 s budget
  - f/g = floor 6 with partial server fixes
  - h = floor 6 with the recommended server fixes
  - i = h with per-process env drift

  There are also 7 ablations `h_minus_<fix>` and the mutant `m`.
- **Abstractions.** One run; 2 deliveries; at most 1 crash and 1 canceller.
  Stale reads may return any committed row version. Race configs only use
  attesting world-vercel targets. Turbo counts as attempt 1 with stamp >= 3.
  Local worlds are modelled only as over-max refusal.
- **Code mapping** (header of the `.tla`):
  - `Stamp` -> `start.ts:117-138, 587-588`
  - `Explicit` -> `runs.ts:83-130`, `cli inspect/run.ts:87-109`
  - `XUpg`/`XTx` -> `run-spec-version-upgrade.ts:96-208`
  - `XTrans` -> `events.ts:2376-2415`
  - `XRsCreate` -> `events.ts:8056-8238`
  - `XReplay` -> `slot-identity.ts:116-124`
  - `XComplete` -> `workflow.ts:1254`
  - `KPatch` -> `events.ts:2588-2650`

### ServerRaiseProtocol (TLA+): the #1044 raise at DB-operation granularity

`ServerRaiseProtocol/ServerRaiseProtocol.tla`. It models one run with these
actors:

- the caller's `run_created`, as a row create followed by a separate event
  insert; it can fail or crash
- 2 or 3 concurrent `run_started` deliveries with redelivery. Each goes
  through: fetch (possibly stale, or missing, which leads to resilient
  start), upgrade check, consistent head read, conditional `transactWrite`,
  reread, id-mode choice from the held run, state patch, and insert (the
  probing allocator returns 500 on a mixed log)
- replay (`requireEventSlot`, and a missing `run_created` gives
  SCHEMA_VALIDATION, then `run_failed`), then one step
- a canceller
- a crash after resilient create, after the tx, or after the transition,
  plus the v4 missing-run-event recovery (delete the row only, then rebuild
  through resilient start)
- MAX_DELIVERIES `run_failed`

Stamps are `{3,6,7,8}` and executor versions `{6,7,8}`, chosen
nondeterministically.

There are 13 safety invariants and action properties, plus progress checks:
`NoStuck`, `GoodOutcome`, and `Termination` under weak fairness. Progress
runs assume bounded latency: the real queue spaces 48 deliveries over 9 to
10 h. `RECOMMENDED__PROGRESS_noBL` shows why that assumption is needed.

The fix toggles are:

| Fix | Change |
|---|---|
| P1 | Resilient start creates the run at `max(stamp, exec)`, and the conflict refetch upgrades |
| P1e | The synthetic `run_created` carries that spec too |
| P2/P2b | The not-committed / not-fresh skips become retryable |
| P3 | The ULID-mode terminal patch also requires `spec == held` |
| P4 | The `run_started` patch requires `status == pending && spec == held`, else reread |
| P5 | The run row and `run_created` are written in one `transactWrite` |

Code mapping is in the `.tla` header and `gen_cfgs.py`.

### MidRunRaiseGates (TLA+): the version lattice, reader gates, force-claim

- `MidRunRaiseGates.tla` does three things:
  - It checks #1044's hard-coded "crossing 6 or 7 needs a fresh log" rule
    against an allow-list alternative over versions 1..9. `StructuralSet`
    is a constant, so a hypothetical structural 9 can be added.
  - It adds reader-code and caller-code dimensions (`ExecutorCanReplay`,
    `CallerCanDecode`), turbo, recovery and resurrection.
  - It checks a "Full" configuration with all concurrency (8.6M states with
    all fixes).
- `ForceClaimGate.tla` checks the #4193 force-claim victim gate
  (`understandsForcedHookDisposal(v) = v >= 8`) against a concurrent #1044
  raise. The claimer's read and its decision are separate steps. The model
  also includes a stale second starter, CLI-reuse stamps, and explicit
  stamps.
- Code mapping: `run-spec-version-upgrade.ts:99-104` (fresh-log rule),
  `events.ts:6050-6100` (force-claim), `version-utils.ts:98-102,166`.

### ResolveLean (Lean 4, core only): proofs plus an explicit-state checker

`ResolveLean/CrossDeploy/*.lean`. 112 theorems, no `sorry`.

- `Resolve.lean` (22 theorems, kernel-checked over unbounded inputs):
  - `resolveCrossDeploymentSpecVersion` is always <= the caller's version
  - a valid version `v` gives exactly `min v c`
  - the result is >= 1 whenever `c >= 1`
  - it is monotone
  - the floor-3 proposal differs from #4327 only on a miss (6 vs 3) and on
    malformed JSON (2 vs 3)
- `Raise.lean` (19 theorems; the control-flow core is checked by `decide`
  over all 3072 inputs):
  - the raise never lowers the version, **assuming the DB never lowers the
    spec between read and reread** (`upgrade_can_lower_without_hmono` shows
    this assumption is necessary)
  - a crossing of 6 or 7 implies a fresh log
  - the stale-skip witnesses
- `StaleSkip.lean` (34 theorems, `native_decide`) is a BFS model checker
  written in Lean. It covers N looping starters, the split `run_created`, a
  terminal writer, a crash, recovery, resilient start, and id resolution
  fixed before the patch (ULID, probing allocator, or sequencer with
  fence/raiseFloor). Fix toggles: `rereadOnSkip`, `cas`, `reresolve`,
  `wait`, `resilientUpgrade`, `casTerminal`, `adoptOrphan`,
  `recoveryReset`. It checks up to 3 starters.
- `Combined.lean` (36 theorems) composes the client stamp with StaleSkip's
  quiescent outcomes across 234 well-formed targets. Client stamp sources:
  `current`, `proposed`, `explicit(v)`, `recreateSame`, `recreateRedirect`,
  `cli`, `stableCaller`. It checks acceptance, an all-slot log, argument
  decodability and output decodability.

### Completeness (TLA+ and Lean): gaps the other models do not cover

- `RolloutSkew.tla`: two workflow-server builds serve one run during a
  deploy or rollback.
- `SharedPool.tla`: world-postgres mixed-version worker pools, rolling
  upgrade and rollback, and package skew with the kill switch.
- `AttestSound.lean` (6 theorems): when #4366's attestation matches what the
  executor can actually read.

## How to run

```sh
./run.sh                        # every model; exit 0 iff all verdicts match
JOBS=5 ./run.sh                 # run the five models in parallel
./run.sh MidRunRaiseGates ...   # a subset
```

Requirements:

- Java 11+.
- `tla2tools.jar`. If `TLA2TOOLS` is unset, `run.sh` downloads
  [v1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4) (TLC
  2.19, the version these results were produced with) to
  `${XDG_CACHE_HOME:-~/.cache}/workflow-formal/` and verifies its SHA-256.
- Lean 4.34.1 via [elan](https://github.com/leanprover/elan). The
  `lean-toolchain` file here pins it. Or set `LEAN=/path/to/lean`. Only core
  Lean is used: no Mathlib, no Lake.
- `python3`, `curl`, `sha256sum`.

`run.sh` runs each model's own `run.sh`. The logs go to `results/<Model>.log`,
and the full outputs are rewritten in `<Model>/results/*.txt`. It then
classifies every result file with `verdicts.py` into `results/verdicts.txt`
(PASS / VIOLATION(<property>) / PROVED / ERROR / FAILED), compares that
against `expected-verdicts.txt`, and prints a per-model summary.

The last full run (`JOBS=5 ./run.sh`, 2026-09-25, 8 cores) took 1 h 46 min
wall time. ServerRaiseProtocol alone takes 1 h 46 min and bounds the total;
StartStamping takes 46 min, MidRunRaiseGates 6 min, ResolveLean 4 min and
Completeness under 1 min. Run serially, the suite takes about 2 h 45 min.
All 783 verdicts matched `expected-verdicts.txt`:

| model | result files | pass | violation | proved | errors |
|---|---:|---:|---:|---:|---:|
| StartStamping | 321 | 140 | 181 | 0 | 0 |
| ServerRaiseProtocol | 387 | 249 | 138 | 0 | 0 |
| MidRunRaiseGates | 47 | 19 | 28 | 0 | 0 |
| ResolveLean | 5 | 0 | 0 | 5 (112 theorems) | 0 |
| Completeness | 23 | 10 | 12 | 1 (6 theorems) | 0 |

A "violation" is often the *expected* outcome. Examples: a counterexample
against the code as written, a mutant, a reachability witness, or an
ablation that shows a fix is necessary. The per-model `run.sh` for
MidRunRaiseGates and Completeness encodes the expected outcome of each
config. For all models, `expected-verdicts.txt` is the regression baseline.

## Results

### Headline table

Outcome is what TLC/Lean reported. "pass" means the property holds on the
whole bounded state space; "proved" means a Lean theorem.

| Model | Variant | Property | Outcome | Result file |
|---|---|---|---|---|
| Resolve (Lean) | #4327 and floor-3 | stamp <= caller; valid v -> `min v c`; >= 1; monotone | proved | `ResolveLean/results/Resolve.txt` |
| Raise (Lean) | #1044 | never lowers (given `hmono`); fresh-log on crossing 6/7; never commits on terminal | proved | `ResolveLean/results/Raise.txt` |
| Raise (Lean) | #1044 | returned run reflects the persisted row | violated (stale-skip witness) | same |
| StartStamping | a (main before #4327) | NoOverStamp (non-explicit) | violated: mainline caller -> every older target | `StartStamping/results/a_main_before_4327.txt` |
| StartStamping | b (#4327) | NoOverStamp / StampRunnable | violated only on a miss or no channel against pre-6 targets, plus explicit stamps | `b_4327__NoOverStamp.txt` |
| StartStamping | a-i | CallerCap, AttrGateMatchesStamp, TargetCanReadInput | pass | `*__CallerCap.txt` ... |
| StartStamping | b | AttributesGateCorrect | violated (miss -> 6 accepts attributes a v4 target cannot store) | `b_4327__AttributesGateCorrect.txt` |
| StartStamping | c (#4327+#4366+#1044) | NoMixedIdentityLog | violated (stale starter; cancel race; recovery) | `c_4327_4366_1044__NoMixedIdentityLog.txt`, `__race_cancel__`, `__race_recovery__` |
| StartStamping | c, default filter (mainline, non-explicit) | NoMixedIdentityLog, CallerCanReadResult | pass (floor 6 keeps stamps >= 6 on v5 slot readers) | `c_..._default__NoMixedIdentityLog.txt` |
| StartStamping | c | CallerCanReadResult | violated (stable caller's raised run compresses its output) | `c_4327_4366_1044__CallerCanReadResult.txt` |
| StartStamping | c, race_recovery | SpecNeverLowered | violated (recovery rebuilds at the stamp: 6 -> 3) | `c_..._race_recovery__SpecNeverLowered.txt` |
| StartStamping | d/e (floor 3, 2 s) | NoMixedIdentityLog, default filter | violated (mixed log reaches the *default* path) | `d_floor3_2s_resilientfix__default__NoMixedIdentityLog.txt`, `e_...` |
| StartStamping | h (recommended) and i (+env drift) | NoAvoidableBrick, NoMixedIdentityLog, NoResurrect, SpecNeverLowered, SingleRunCreated, NoOverRaise, CallerCanReadResult (core, default, cancel, recovery) | **pass** | `h_floor6_10s_recommended__*.txt`, `i_recommended_envdrift__*.txt` |
| StartStamping | h minus P1/P4/P5/id-mode/compress | the corresponding invariant | violated (each is necessary) | `h_minus_*.txt` |
| StartStamping | h minus SkipReread / RecoveryAdopt | all avoidable invariants | pass (redundant given the others) | `h_minus_FixSkipReread.txt`, `h_minus_FixRecoveryAdopt.txt` |
| StartStamping | m (mutant attests mint+1) | NoOverRaise | violated (restated invariant is non-vacuous) | `m_mutant_attest_above_max__NoOverRaise.txt` |
| ServerRaiseProtocol | CURRENT (#1044) | NoDoomedRun | violated, 5 states (resilient start at 3) | `ServerRaiseProtocol/results/CURRENT.txt` |
| ServerRaiseProtocol | CURRENT_iso_starters (consistent reads only) | NoMixedIdentityLog | violated (stale log-not-fresh skip) | `CURRENT_iso_starters.txt` |
| ServerRaiseProtocol | CURRENT_iso_cancel | NoMixedIdentityLog | violated (cancel vs raise) | `CURRENT_iso_cancel.txt` |
| ServerRaiseProtocol | CURRENT_crash | SpecNeverLowered, RunCreatedSpecMatchesRow | violated (recovery rebuild lowers 6 -> 3, second run_created) | `CURRENT_crash__SpecNeverLowered.txt` |
| ServerRaiseProtocol | any variant | SpecMonotonic, NoStructuralCrossAfterFirstNonCreatedEvent | pass (the transaction's own conditions are sound) | `*__SpecMonotonic.txt` |
| ServerRaiseProtocol | PROPOSED_FULL (P1-P4, no P5) | ReplayNeverFails | violated (run_started lands between the run row and run_created) | `PROPOSED_FULL.txt` |
| ServerRaiseProtocol | PROPOSED_FULL_crash | RunCreatedPresent | violated (caller crash between the two writes) | `PROPOSED_FULL_crash.txt` |
| ServerRaiseProtocol | RECOMMENDED = P1+P1e+P3+P4+P5 | all safety + progress | **pass** (249,657 states) | `RECOMMENDED.txt`, `RECOMMENDED__PROGRESS.txt` |
| ServerRaiseProtocol | RECOMMENDED_crash (crash + recovery) | all safety + progress | **pass** (3,579,823 states) | `RECOMMENDED_crash.txt` |
| ServerRaiseProtocol | RECOMMENDED_D3 (3 deliveries) | all safety + progress | **pass** (12,833,511 states) | `RECOMMENDED_D3.txt` |
| ServerRaiseProtocol | RECOMMENDED minus P1 / P1e / P3 / P4 / P5 | NoDoomedRun / RunCreatedSpecMatchesRow / NoMixedIdentityLog / NoDoomedRun / NoDoomedRun | violated (each is necessary); P2 is redundant under P5 | `RECOMMENDED_no*.txt` |
| ServerRaiseProtocol | RECOMMENDED_crash_noGrace | NoMixedIdentityLog | violated (the 60 s recovery grace window is load-bearing) | `RECOMMENDED_crash_noGrace.txt` |
| MidRunRaiseGates | Default_S67 / AllowList_S67 | ReplayConsistent, NoNeedlessRefusal | pass | `MidRunRaiseGates/results/Default_S67.txt` |
| MidRunRaiseGates | Default_S679 (hypothetical structural 9) | ReplayConsistent | violated (default-allow is not future-proof) | `Default_S679.txt` |
| MidRunRaiseGates | G1_NotCommitted / G1_ResilientStart | ExecutorCanReplay | violated | `G1_*.txt` |
| MidRunRaiseGates | G2_CancelRace / G2_StaleStarters | NoMixedIdentityLog | violated | `G2_*.txt` |
| MidRunRaiseGates | G3_StableCaller | CallerCanDecode | violated; G3_StableCaller_StampGate passes | `G3_*.txt` |
| MidRunRaiseGates | G5_Recovery_* | Monotone, NoMixedIdentityLog | violated; G5_Recovery_Fixed passes | `G5_*.txt` |
| MidRunRaiseGates | G6_Resurrect | TerminalAbsorbing | violated; G6_Resurrect_Guarded passes | `G6_*.txt` |
| MidRunRaiseGates | Full_Proposed | ExecutorCanReplay, NoMixedIdentityLog, Monotone, TerminalAbsorbing | **pass** (8,633,754 states) | `Full_Proposed.txt` |
| MidRunRaiseGates | Full_Proposed | ReplayConsistent | violated (non-bricking residual, see R4) | `Full_Proposed__ReplayConsistent.txt` |
| MidRunRaiseGates | FC_Main_Probe / FC_Head4327_Probe / FC_Stable_Probe | NoStrandedVictim, GateSound | pass | `FC_*_Probe.txt` |
| MidRunRaiseGates | FC_Head4327_Explicit / FC_Stable_Explicit | NoStrandedVictim | violated (uncapped explicit stamp >= 8) | `FC_*_Explicit.txt` |
| MidRunRaiseGates | FC_Main_Resurrect | NoStrandedVictim | violated; FC_Main_Resurrect_Guarded passes | `FC_Main_Resurrect*.txt` |
| StaleSkip (Lean) | asIs, 2 starters, fresh and late paths | noMixed, oneStarted, noAlloc500 | violated (`staleSkip_witness`, 7 steps) | `ResolveLean/results/StaleSkip.txt` |
| StaleSkip (Lean) | CAS on the patch, id left stale | noMixed | violated (the natural `.where` fix is not enough) | same (`pairs_late_casStaleId`) |
| StaleSkip (Lean) | allFixes (cas+reresolve+wait+resilientUpgrade+casTerminal+recoveryReset) | every invariant, end-state property, `canFinish`; N=2 and N=3; crash + recovery; terminal writer | **pass** | same |
| StaleSkip (Lean) | allFixes but recovery adopts the orphan (no reset, no P5) | monotone, oneCreated | violated with the row missing (the client's late run_created re-creates it) | same (`crash_missing_allFixesAdopt`) |
| Combined (Lean) | asIs, floor 3 | brick on a miss | possible iff `hi<3 ∨ 3<lo`, on **every** path incl. fresh | `ResolveLean/results/Combined.txt` (`race_miss_proposed_asIs_iff`) |
| Combined (Lean) | allFixes, floor 3 | brick on a miss | iff `hi<3 ∨ (3<lo ∧ no attestation)` | same (`race_miss_proposed_fixed_iff`) |
| Combined (Lean) | #4327 floor 6 | brick on a miss | iff `hi<6` (stable, pre-3, older betas), always | same (`race_miss_current_iff`) |
| Combined (Lean) | stable caller -> v5 world-vercel | usable result | never (brick or unreadable output), even with every fix | same (`race_stable_caller_into_v5wv`) |
| Combined (Lean) | all 33 client sources | args decodable by target | pass | same (`race_args_decodable`) |
| RolloutSkew | new build with fixes, no rollout gate | NoMixedIdentityLog | violated (old-build in-flight write, consistent reads) | `Completeness/results/RS_Skew_Fixed_NoGate_Consistent.txt` |
| RolloutSkew | fixes + server flag, rollback after settle | all | pass; rollback without settle is violated | `RS_Skew_Fixed_Flag_Rollback.txt`, `RS_Skew_Fixed_Flag_RollbackNoSettle.txt` |
| AttestSound (Lean) | #4366 recompute vs captured | attestation <= reader max | unsound iff env mutates in-process with package skew; captured value always sound | `Completeness/results/AttestSound.txt` |
| SharedPool | world-postgres package skew + kill switch | SafeExec | violated (gate checks the World package's max, not core's) | `SP_PkgSkew_KillSwitch.txt` |
| SharedPool | rollback, same-deployment starts | Liveness | violated (run_failed after MAX_DELIVERIES); kill switch on the new build makes it safe | `SP_Rollback_Same.txt`, `SP_KillSwitchNew_Rolling.txt` |

### Findings

Each finding was traced back to the code by an adversarial verifier. The
verifier tried to refute the counterexample, and each finding is classified
as one of:

- **new bug**: real, and introduced or exposed by the stack
- **known residual**: real, and already documented in a PR or code comment
- **pre-existing**: real, but independent of the stack
- **fixed by proposal**: the stack removes it
- **by design / model artifact**: an intentional escape hatch or a
  hypothetical configuration

#### Client (#4327)

- **C1. Pre-#4327 over-stamping: fixed by proposal.** On main, `start.ts:449`
  stamps `opts.specVersion ?? world.specVersion`, and the probe only picks
  framing. A main caller stamps 7 or 8 into a target that runs 2, 3 or 7.
  #4327's `Math.min(target, caller)` (`start.ts:137`) removes every mainline
  over-stamp against targets that answer the probe (StartStamping a vs b;
  `answered_json_accepts`).
- **C2. Probe miss floor 6 bricks targets whose max is below 6: known
  residual.** The docblock at `start.ts:102-108` says so ("No single floor
  serves both"). A miss or missing channel into stable (max 3), pre-3, or
  v5 betas that mint 4/5 stamps 6. None of #4366 or #1044 can lower it,
  because the raise only goes up. On the same path, `AttributesGateCorrect`
  fails: stamp 6 lets `attributes` through to a target that cannot store
  them. Lean: `race_miss_current_iff` (bricks iff `hi < 6`).
- **C3. The TODO to drop the miss floor to 3 is unsafe against #1044 as
  written: design constraint.** With floor 3 (variants d/e,
  `race_miss_proposed_asIs_iff`):
  - a miss bricks every v5 world-vercel target without #4366 (the published
    beta 7)
  - the stale-starter race reaches the *default* path and mixes the log
  - the not-committed and resilient paths leave ULID ids
  - with a 2 s budget, slow plain-text replies turn into misses (stamp 3 > 2)
  - `attributes` are falsely refused on every slow or missed probe (stamp 3 < 4)

  Even with every server fix, floor 3 is safe only once every reachable v5
  target attests (`race_miss_proposed_fixed_iff`).
- **C4. Explicit, replay and CLI stamps are uncapped: by design
  (pre-existing escape hatch), hardening recommended.** `start.ts:587-588`
  lets `opts.specVersion` win uncapped. Same-deployment replay copies the
  source run's spec. The CLI keeps `run.specVersion` after a miss or a
  plain-text reply. Consequences:
  - an explicit or reused 8 on a #4327-head victim (code 7) or on a stable
    victim unlocks the force-claim gate, and the victim's `await hook` is
    stranded (`FC_Head4327_Explicit`, `FC_Stable_Explicit`,
    `FC_Stable_Explicit_GateSound`)
  - `CallerCapExplicit` fails
  - nothing on the Vercel path refuses a run above core's max
    (`requiresNewerWorld` is only called in world-local and world-postgres)
- **C5. Minor: false or theoretical.**
  - The `start.ts:98-101` comment "a JSON reply with a malformed version ...
    errs low, which is safe" is false for targets whose floor is above 2.
    No in-repo responder sends such a reply, so this is a model artifact
    and a documentation nit.
  - `cli_zero_version`: the CLI would stamp 0 from a JSON `specVersion: 0`,
    because it has no `>= 1` check. Again, no responder sends it.

#### Executor (#4366)

- **E1. The attestation can over-claim: new (hardening).** In
  `AttestSound.lean`, `mintedSpecVersion()` re-reads `process.env` on every
  call. Core validates only `world.specVersion`, which is captured at
  `createWorld`. With core max 7 and world-vercel from main, started with
  `WORKFLOW_SEALED_LOG=0` and then flipped on in-process, the executor
  attests 8, #1044 raises the run to 8, and force-claim is unlocked for a
  reader that cannot understand it.
  - `recompute_unsound_iff`: this is the only unsafe case.
  - `captured_sound_always`: sending the captured `world.specVersion`
    instead is sound unconditionally.
  - On Vercel the env is fixed per deployment, so the practical risk is low.
- **E2. Shipping #4366 before #1044 is safe: argued.** The pre-#1044
  `parseV4EventMeta` ignores unknown meta keys.

#### Server (#1044)

The raise transaction itself is sound. `SpecMonotonic` and
`NoStructuralCrossAfterFirstNonCreatedEvent` hold in every ServerRaiseProtocol
variant, and `Raise.lean` proves the fresh-log condition. Every failure below
comes from code *around* the transaction.

- **S1. Resilient start never raises: known residual.** When `run_started`
  finds no run (the caller's `run_created` failed or is late), `events.ts`
  8056-8238 creates the run at the caller's stamp and gives the synthetic
  `run_created` a ULID. `upgradeRunSpecVersion` is only called on the
  found-run path (`events.ts:8047-8053`). A stable caller (stamp 3) into
  main then runs at 3 with ULID ids, and the v5 executor fails at replay.
  Found as the `CURRENT` headline (5 states), `G1_ResilientStart` and
  `h_minus_RaiseOnResilient`. Fix: P1 (create at `max(stamp, exec)`, and
  upgrade on the conflict refetch) plus P1e (the synthetic `run_created`
  carries the same spec; otherwise `RunCreatedSpecMatchesRow` fails in 3
  states).
- **S2. The `run-created-not-committed` skip falls through: new bug (also raised by alangenfeld in review on #1044).**
  `handleRunCreated` writes the run row and, later, the `run_created` event.
  `start()` sends `run_created` and the queue message concurrently (both
  stable and v5). A `run_started` in that window gets an empty head, skips
  (`run-spec-version-upgrade.ts:113`) with the input run, patches it
  `running` at the stamp, and inserts a ULID `run_started`. After that,
  every raise skips as `log-not-fresh`, so the run is doomed.
  Found by `PROPOSED_FULL_noP2`, `G1_NotCommitted` and StaleSkip `raised`.
  Fix: P5 (atomic row + `run_created`), which also makes P2 unnecessary, or
  P2 (retry this skip).
- **S3. Stale-starter skip corrupts the log: new bug.** Two `run_started`
  deliveries both read `pending@3`. A commits the re-key to slot 1 and spec
  8. B's head read then sees a slot `run_created` or a second row, and B
  returns `skip('log-not-fresh')`. `skip()` hands back B's *stale input run*
  (`run-spec-version-upgrade.ts:83-92`; only lost-race rereads). The
  id mode is then fixed from spec 3 (`events.ts:8280`). The unconditional
  patch (`events.ts:2398-2405`) goes through, and a ULID `run_started`
  lands in the slot log. The result is a mixed identity log: `probeMaxSlot`
  returns 500, replay fails, and there is a duplicate `run_started`.
  - Reproduced with consistent reads only (`CURRENT_iso_starters`, 11
    states) and replayed step by step in Lean (`staleSkip_witness`).
  - A stamp >= 6 never produces a ULID, so the #4327 default path is not
    affected. Exposure is stable callers, explicit or CLI stamps, and
    plain-text targets.
  - Fix: P4, a `run_started` patch conditioned on
    `status == pending && specVersion == held`. On failure it rereads,
    **and re-resolves the event id from the reread run**. A `.where` alone
    is not enough, because the id assignment is resolved before
    `handleRunStateTransition` (`pairs_late_casStaleId` still mixes).
    Reread-on-skip alone does not fix it either (`rereadOnly_mixed_possible`).
- **S4. A cancel racing the raise corrupts the log: new bug, and the same case as #1044's known residual 1, now confirmed by the model.** Before
  #1044 a run's spec never changed, so an id mode chosen at read time could
  not go stale. Now a `run_cancelled` (or `run_failed`) that read
  `pending@3` picks ULID mode. The raise re-keys the log to slot 1 in
  between. The ULID-mode patch is guarded only on non-terminal
  (`events.ts:2618-2635`), so it succeeds, and a ULID terminal event lands
  in the slot log. Found by `CURRENT_iso_cancel` (9 states) and
  `G2_CancelRace`. The same class covers any post-start write whose id
  mode comes from a stale read (`h_minus_FixConsistentIdMode`). Fix: P3,
  the ULID-mode terminal patch conditioned on `specVersion == held`,
  re-resolving on failure.
- **S5. Terminal resurrection: pre-existing, widened by #1044.** The
  unconditional `run_started` patch moves a `cancelled` or `failed` run
  back to `running` (same code on origin/main). #1044 widens the window
  with its head read, transaction and reread, and the lost-race path
  returns a possibly terminal reread that nothing re-checks.
  `FC_Main_Resurrect` shows it also strands a force-claim victim on main
  code. Fix: P4.
- **S6. Recovery after a raise lowers the spec and duplicates run_created:
  new bug (interaction).** Sequence (`CURRENT_crash__SpecNeverLowered`,
  `G5_Recovery_*`, StartStamping `c__race_recovery`, StaleSkip
  `crash_fresh_asIs`):
  1. Raise 3 -> 6 (re-key).
  2. Patch `running`, then crash before the `run_started` insert.
  3. The v4 missing-run-event recovery (`v4/events.ts:1650-1830`) deletes
     only the run row.
  4. The retry rebuilds the run through resilient start at stamp 3. The
     spec goes 6 -> 3, a second `run_created` (ULID) appears next to the
     slot-1 orphan, and the log is mixed.

  Two fixes are verified:
  - (a) recovery resets the wedged run to `pending` instead of deleting it
    (StaleSkip `allFixes`)
  - (b) resilient start adopts the orphan `run_created` and its spec, **and**
    creation is atomic (P1 + P5: `RECOMMENDED_crash`)

  Adoption without P5 or reset is not enough: the client's late
  `run_created` re-creates the row at the stamp
  (`crash_missing_allFixesAdopt`).
- **S7. The raise makes a stable caller's result unreadable: known
  residual.** #1044's "Known residuals" item 3 lists this. A stable caller
  (stamp 3) into main is raised to 6 or 8. The non-turbo invocation reads
  spec >= 5 and compresses the return value (`workflow.ts:1254`). Stable's
  `decodeFormatPrefix` only knows `devl` and `encr`, so `Run.returnValue`
  throws. Healing therefore turns a brick into an unreadable result
  (`G3_StableCaller`, `c__CallerCanReadResult`,
  `race_stable_caller_into_v5wv`: never a usable result). Fix, verified in
  `G3_StableCaller_StampGate`, `Full_Proposed_StableCaller` and
  `h_minus_FixCompressOnStamp`: gate output compression on
  `min(run_created stamp, spec)`, i.e. the stamp the caller declared.
- **S8. The two-write run_created window fails the run at replay:
  pre-existing.** Even with stamp >= exec (the `not-newer` skip, so no
  head read), `run_started` and its preload can land between the run row
  and the `run_created` event. The non-turbo replay then throws
  SCHEMA_VALIDATION, which becomes `run_failed` (`PROPOSED_FULL`, 7
  states). A caller crash between the two writes leaves a live run with no
  `run_created` (`PROPOSED_FULL_crash`, `RunCreatedPresent`). Fix: P5.
- **S9. Server rollout and rollback skew: new (operational).** The raise
  has no server flag. During a workflow-server deploy or rollback, an
  in-flight request on the old build has no P3/P4 guards. Once the new build
  has raised and re-keyed the run, that old request writes a ULID event
  into the slot log (`RS_Skew_Fixed_NoGate_Consistent`, 7 states, even with
  consistent reads and all fixes on the new build). This is safe only with
  a rollout gate:
  - (a) the fixes are on the whole server fleet before any raise can fire,
    for example by shipping #1044 + fixes before #4366 reaches users, or by
    turning the raise on with a server flag
  - (b) before any server rollback, turn the flag off and let eventually
    consistent reads settle (`RS_Skew_Fixed_Flag_RollbackNoSettle` fails;
    `RS_Skew_Fixed_Flag_Rollback` passes)
- **S10. The fresh-log rule is default-allow: by design, future-proofing
  note.** `requiresFreshLog` names 6 and 7 explicitly. A future
  version that changes how rows are read would be raised mid-run
  (`Default_S679`). An allow-list of capability-only versions
  `{3,4,5,8}` is safe; its cost is refusing a future capability version
  until it is listed (`AllowList_S67_Cap9_Cost`). Today's versions behave
  identically under both rules.

#### Worlds and pools (context, not caused by the stack)

- **W1. world-postgres checks the World package's max, not core's:
  pre-existing, new finding.** `requiresNewerWorld` compares against the
  World package's `SPEC_VERSION_MAX_SUPPORTED`. A worker running core max 7
  with an 8-era world-postgres and the kill switch on declares 6, passes
  the compatibility check, and replays spec-8 runs that other workers
  created (`SP_PkgSkew_KillSwitch`, 3 states).
- **W2. Mixed-version world-postgres pools: pre-existing.** The queue
  ignores `deploymentId`. A spec-8 run created by the new build during a
  rollback is refused by old workers until MAX_DELIVERIES, then gets
  `run_failed` (`SP_Rollback_Same`, `SP_Rolling_Same_Slow`). #4327 helps
  cross starts, because a stamp capped at the old version survives
  (`SP_Rollback_Cross_4327_LowStamp` passes). Deploying the new build with
  the kill switch on makes rollback safe (`SP_KillSwitchNew_Rolling`).

#### Residuals left after every proposed fix

- **R1.** C2: a probe miss into a target whose max is below 6. This is
  inherent to any single floor.
- **R2.** A stable caller into a v5 world-vercel target cannot get a
  usable result without the compression gate from S7.
- **R3.** Explicit stamps outside `[lo, hi]` (C4). Raw `NoBrick` and
  `NoStuck` in h and i fail only for stamps that `StampRunnable` already
  rejects.
- **R4.** `Full_Proposed__ReplayConsistent`: recovery resets a run while
  an older delivery's insert, which held spec 6, is still in flight. A new
  delivery raises the run to 8, and the old insert then lands under the
  unsealed regime. The row is slot-numbered, so the sequencer's conflict
  repair absorbs it. This is a regime mismatch, not a brick. Closing it
  would need recovery to fence in-flight requests, for example with a row
  generation that inserts are conditioned on.
- **R5.** The recovery grace window, and the bounded-latency assumption in
  the progress runs, are load-bearing (`RECOMMENDED_crash_noGrace`,
  `slowWriter_allFixes`, `RECOMMENDED__PROGRESS_noBL`).

### Recommendations

**#4327 (client)**
1. Keep miss floor 6 and the 10 s budget. Reword the TODO on
   `resolveCrossDeploymentSpecVersion`: the floor may drop to 3 only after
   (a) #1044 ships with the fixes below on the whole server fleet, and
   (b) every v5 target a caller can reach sends `executorSpecVersion`
   (C3). Even then, a floor below 4 falsely refuses `attributes`, so
   either keep the floor >= 4 or skip the attributes gate on a miss.
2. Fix the "errs low, which is safe" comment (C5), and have the CLI reject
   a probed `specVersion < 1`.
3. Consider warning, or capping at the probed target, when an explicit
   `opts.specVersion`, a same-deployment replay, or a CLI fallback stamp
   exceeds the target's reported version (C4). The stronger fix is in core,
   below.
4. Rebase onto main. The #4327-head profile (max 7) disappears, and with it
   the `CallerCapExplicit` cases at source spec 8.

**#4366 (executor)**
1. Send the `world.specVersion` captured when the World was created,
   instead of calling `mintedSpecVersion()` per request (E1,
   `captured_sound_always`).
2. It is safe to ship before #1044 (E2). But the raise must not be able to
   fire on any server build without the fixes, which is a rollout
   requirement on #1044 (S9).

**workflow-server#1044 (backend).** The minimal set verified in every
model is P1 + P1e + P3 + P4 + P5, plus a recovery fix and a compression
gate. Each of these was shown necessary by ablation.
1. **P1 / P1e (S1).** Resilient start creates the run and the synthetic
   `run_created` at `max(input.specVersion, executorSpecVersion)`. The
   conflict refetch runs the upgrade. Skip the raise for legacy
   `spec <= 1` runs: StaleSkip found that without this guard the fix
   raised a legacy run.
2. **P5 (S2, S8).** Write the run row and the `run_created` event in one
   `transactWrite`, in both `handleRunCreated` and resilient start. This
   removes the not-committed window and the replay SCHEMA_VALIDATION race,
   and makes P2 unnecessary. If P5 is not possible, P2: make
   `run-created-not-committed` retryable. That still leaves S8.
3. **P4 (S3, S5).** Condition the `run_started` patch on
   `status == 'pending' && specVersion == held`. On a condition failure,
   reread and **re-resolve the event id assignment from the reread run**
   before inserting: return `alreadyRunning` or 410. Also re-check for a
   terminal state after `upgradeRunSpecVersion`.
4. **P3 (S4).** Condition the ULID-mode terminal patch (`run_cancelled`,
   `run_failed`, `run_completed`) on `specVersion == held`, and re-resolve
   on failure. More generally, never number an event from a run read that
   the raise can have invalidated.
5. **Recovery (S6).** Make `recoverMissingRunEvent` reset a wedged run to
   `pending` rather than delete it. Or have resilient start adopt the orphan
   `run_created` and its spec, which is only safe together with P5. Keep the
   60 s grace window.
6. **Compression (S7).** Gate output compression on the stamp the caller
   declared (`min(run_created stamp, spec)`), so a raised stable-caller
   run stays readable by its caller. Otherwise, document in #1044 that a
   stable caller into main can never read the result.
7. **Rollout (S9).** Put the raise behind a server-side flag. Enable it only
   after the fixed build is on the whole fleet. Before any server rollback,
   turn the flag off and wait for eventually consistent reads to settle.
8. **Future-proofing (S10).** Replace the hard-coded 6/7 fresh-log rule
   with an allow-list of versions that may be crossed on a non-fresh log
   (`{3,4,5,8}` today), or at least add a comment tying future structural
   versions to `requiresFreshLog`.

**Core (follow-up, outside the stack).** Refuse to replay a run whose
`run.specVersion` exceeds core's own `SPEC_VERSION_MAX_SUPPORTED`, failing
closed on every World. That one check covers the explicit-stamp force-claim
strands for v5 victims (C4), the E1 over-claim, and the world-postgres
package-skew gap (W1).
