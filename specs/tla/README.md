# TLA+ specification: replay-engine prefix consistency

Formal model of the Workflow SDK replay engine's **delivery-ordering
discipline**, built to establish (or refute) the foundational correctness
property of durable replay:

> **Prefix consistency.** For every prefix of the event log, the replay
> engine's suspension output is correct and can be trusted, even if the log
> has grown past that prefix in the meantime: replaying a longer log never
> contradicts the paths, commands, or suspension output derived from any
> shorter prefix — assuming the log is strictly append-only (no events are
> ever inserted between existing events).

## Status / headline results

Checked with TLC (all runs exhaustive at the configured schedule sizes):

| Config | Discipline | Invariants | Result |
| --- | --- | --- | --- |
| `ReplayDeliveryCurrent.cfg` | Barriers + direct-only step skip (**current engine**, #3406) | PrefixConsistency + Determinism | ✅ **holds** (exhaustive at 6-event schedule, 2 invocations) |
| `ReplayDeliveryCurrentHazard.cfg` | Current engine, on the exact schedule that broke the pre-#3406 engine | PrefixConsistency + Determinism | ✅ **holds** (regression guard) |
| `ReplayDeliveryPre3406.cfg` | Barriers + **transitive** step skip (engine before #3406) | PrefixConsistency | ❌ **violated** — minimal 3-event witness, see [the historical finding](#finding-skip). |
| `ReplayDeliveryRace.cfg` | No barriers (historical engine) | PrefixConsistency | ❌ **violated** — timing decides a wait-vs-step race; two replays of the same log diverge. The `CorruptedEventLogError` class the delivery barriers were built to fix. |

So under this model, **the target theorem holds for the current engine
discipline** (delivery barriers with the direct-only step skip introduced by
[#3406]). The two failing configs are kept as executable history: they
reproduce, from first principles, the two divergence classes the engine has
fixed — the raw timing race (no barriers) and the transitive-skip /
idle-retirement pacing asymmetry (barriers before #3406). Notably, this spec
*independently derived* the pre-#3406 witness before that fix landed: the
scenario in #3406's own description (a hook created but not read on this
branch, `step` raced against `sleep`, the log says the sleep won) is the
model's minimal counterexample trace.

[#3406]: https://github.com/vercel/workflow/pull/3406

## What is modeled

The model deliberately reduces the engine to the one mechanism the theorem
hinges on: **in which order do event-log resolutions become visible to
workflow code?**

The reduction is justified by a factoring lemma:

> **Lemma (deterministic guest).** Workflow code is a deterministic function
> of the sequence of deliveries it observes (assumption A2). Therefore every
> downstream observable — control-flow paths, the commands a replay issues,
> per-family correlation-id ordinals (`correlation-id.ts` mints ordinals per
> entity family), and the `WorkflowSuspension` output committed by
> `suspension-handler.ts` — is a pure function of the guest-visible arrival
> sequence. If arrival sequences are deterministic and prefix-monotone
> functions of the consumed log prefix, then so is everything the engine
> commits; concurrent suspension writes then collide idempotently on
> correlation id (`EntityConflictError` dedup) instead of appending
> divergent events.
>
> *Proof sketch:* induction on the arrival sequence; each guest reaction is a
> function of the history so far, and command/ID minting consumes history in
> order. Composition of deterministic functions preserves determinism and
> prefix-monotonicity. ∎

So the spec's single observable is `arrivals[i]` — the guest-visible
delivery order per replay invocation — and the checked property is that any
two invocations' arrival sequences are prefix-comparable at every state
(`PrefixConsistency`), which simultaneously yields determinism (same prefix
⇒ same sequence) and monotonicity (longer prefix ⇒ extension, never
contradiction). Because arrivals are append-only, comparability at every
state is exactly "a suspension computed at prefix *k* stays correct as the
log grows". Crucially, the two invocations also **pace independently** —
one may consume events incrementally with idle gaps (a live invocation)
while the other consumes the full window before delivering (a cold replay)
— so the invariants also rule out live-vs-replay wake-order divergence.

### Model ↔ code map

| Model element | Code (packages/core/src) |
| --- | --- |
| `Consume(i)` — strict in-log-order consumption | `events-consumer.ts` `EventsConsumer.consume` / `eventIndex` |
| `Schedule[e].kind ∈ {hook, wait, step}` | branch-deciding deliveries: `hook_received`, `wait_completed`, `step_completed/failed` (`private.ts` `DeliveryKind`) |
| `DeferBehind` | `private.ts` `DEFER_BEHIND` |
| `GatesOn(i, e, j)` with `SkipMode = "direct"` | `private.ts` `gatesOn` (#3406): a step skips an unarmed entry (unclaimed buffered payload) directly, never transitively |
| `Blocked(i, e)` | `private.ts` `awaitEarlierDeliveries` (evaluated as an arrival-time gate; see caveats) |
| `SelfRes(i, e)` | `private.ts` `resolvesOnItsOwn` / `computeResolvesOnItsOwn` (shares `GatesOn` with `Blocked`, exactly as the implementation shares `gatesOn` — the agreement the fix's comment stakes deadlock-freedom on) |
| `SkipMode = "transitive"` | the pre-#3406 rule: steps skipped every non-self-resolving earlier entry |
| `Schedule[e].armed`, `Claim(i, e)`, `ArmedNow` | `DeliveryBarrierEntry.armed`, `arm()`, and the buffered-payload claim path in `workflow/hook.ts` (claim-time barrier snapshot) |
| `RetireAtIdle(i, e)` | `registerDeliveryBarrier`'s idle safety net (`scheduleWhenIdle` → `finish()`) |
| `Idle(i)` | `scheduleWhenIdle`'s check: `pendingDeliveries == 0 ∧ ¬hasParkedCommittedDelivery` |
| `SuspensionPoint(i)` | an accepted `WorkflowSuspension` (idle check stable, nothing armed still parked) |
| nondeterministic choice among enabled `Arrive`s | variable microtask-hop counts between a delivery's `resolve()` and guest observation (hydration, decryption, iterator wrappers, replay-cache memo hits) |
| `Barriers = FALSE` | the pre-barrier engine (and any path that routes around `awaitEarlierDeliveries`) |

### Assumptions

- **A1 — append-only log.** Events are only ever appended; every reader
  observes a prefix. No interior insertion, no reordering. (The user-level
  hypothesis; discharged operationally by the storage layer — commit-ordered
  sequence work makes reader views prefix-stable. A storage-side spec is
  future work.)
- **A2 — deterministic guest.** Workflow code is a deterministic function of
  observed deliveries (no unrecorded ambient nondeterminism). Enforced
  elsewhere (sandboxed VM, recorded `Date.now`/random, etc.).
- **A3 — resolutions resolve created entities.** `step_completed`,
  `wait_completed`, `hook_received` refer to entities created earlier in the
  log; a step/wait resolves at most once (hooks may receive multiple
  payloads, each a separate event).
- **A4 — same-kind observation homogeneity.** Among *armed* deliveries of
  the same kind, arrival order equals log order. In the implementation this
  is not a `DEFER_BEHIND` edge; it comes from the serial `promiseQueue`
  (hydration slots run in consumption order) plus same-shaped consumer hop
  profiles. The model states the net discipline; a conformance check of A4
  against the implementation is future work.
- **A5 — claim promptness.** A buffered payload the guest claims is
  observed on the guest's own continuation, ahead of freshly-landing armed
  deliveries (the macrotask yield in `awaitEarlierDeliveries` exists to
  enforce this drain order), and simultaneous claims happen in a
  guest-deterministic order. Modeled as claim-priority + lowest-index-first.

### Known modeling simplifications

- The barrier gate is evaluated at **arrival time**, while the
  implementation snapshots "still-registered earlier deliveries" at chain
  start and compensates for the cross-window gap with the step-behind-step
  edge and the macrotask yield. The model states the *intended* invariant;
  implementation conformance is the job of tests
  (`delivery-barrier-coverage.test.ts`, `step-delivery-ordering.test.ts`),
  not this spec.
- Buffered-payload claim points (`claimAfter`) are arrival-**count**
  thresholds. A real guest's claim point is a function of history *content*;
  count thresholds are the special case sufficient for the found
  counterexamples (any content-dependent claim function is expressible by
  extending the schedule constant).
- Creation events, hook conflicts/disposal, aborts, streams, retained-VM
  sessions, and the 412 precondition guard on suspension writes are not
  modeled (see Roadmap).

## Historical finding 1 — no barriers ⇒ timing decides races

`ReplayDeliveryRace.cfg`: with `Barriers = FALSE`, log = ⟨wait, step⟩, TLC
immediately finds two invocations delivering ⟨wait, step⟩ and ⟨step, wait⟩.
A `Promise.race(sleep, step)` flips winners between replays of the *same*
log → divergent paths → divergent correlation ordinals → corrupted event
log. This is the historical bug class the delivery-barrier system fixed,
reproduced from first principles; it also models any code path that routes
around `awaitEarlierDeliveries`.

## Historical finding 2 — transitive skip + idle retirement broke prefix consistency (fixed by #3406) <a name="finding-skip"></a>

`ReplayDeliveryPre3406.cfg`, minimal schedule (3 events):

1. `hook_received` — buffered payload, no consumer waiting, never claimed
2. `wait_completed` — gates on the unclaimed payload at 1 ("a wait must not
   preempt a payload the log ordered first")
3. `step_completed`

Two trajectories over the *same* log under the pre-#3406 rule:

- **Window ends at 2** (live invocation, or replay of the shorter prefix):
  wait 2 parks behind unclaimed payload 1; nothing self-resolving is in
  flight → **idle**; the safety net retires 1's barrier; wait 2 delivers.
  Guest sees **⟨2⟩**.
- **Window includes 3** (replay after the step result landed): the
  transitive skip rule let step 3 pass both 1 (unclaimed) and 2
  (transitively parked) → step delivers **first**. Guest sees **⟨3, …⟩**.

The guest-visible order of the shared prefix depended on an event *beyond*
the shared prefix. A guest racing the wait against the step took different
branches; the suspension committed at prefix 2 (with its correlation
ordinals) was contradicted by the full-window replay — the recorded events
became unconsumable → `CorruptedEventLogError`. The 412 precondition guard
does **not** cover this class: the short-window invocation's writes were
valid when they committed; it is the *later replay* that fails to reproduce
the trajectory that produced them. The same asymmetry broke plain
determinism between live pacing (consume → idle → retire → deliver, one
event at a time) and cold-replay pacing (consume all, then deliver) —
matching the production observation that the residual corruption class was
a live-vs-replay wake-order flip with storage invariants clean.

**The fix ([#3406]):** the skip is now *direct, never transitive*
(`gatesOn` in `private.ts`). A step still skips an unarmed entry (the
unclaimed buffered payload itself) but gates on earlier **armed**
waits/hooks/steps, even ones parked behind such a payload. Why this
restores the theorem: which entries are armed is history-deterministic (a
function of consumption and guest claims, not scheduler timing), so the
step's behavior no longer depends on *whether something downstream of the
payload happened to be parked* — the property that varied with window
length. `resolvesOnItsOwn` shares the same `gatesOn` predicate, so a step
parked behind a parked wait correctly reports non-self-resolving, idle
stays reachable, the payload's safety net retires it, and the whole parked
chain then delivers in log order — identically at every window length.
`ReplayDeliveryCurrentHazard.cfg` checks the fixed discipline against this
exact schedule; `ReplayDeliveryCurrent.cfg` checks it against the
full-featured schedule with both invariants.

## Files

- `ReplayDelivery.tla` — the model (log consumption, barrier discipline,
  claims, idle retirement, invariants). Extensively commented with code
  references.
- `MCReplayDelivery.tla` — concrete schedules (`SafeSchedule`,
  `RaceSchedule`, `SkipHazardSchedule`).
- `ReplayDelivery{Current,CurrentHazard,Pre3406,Race}.cfg` — the four
  experiments from the results table.

## Running

Requires Java and `tla2tools.jar` (gitignored):

```bash
cd specs/tla
curl -sLO https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar
for cfg in ReplayDeliveryCurrent ReplayDeliveryCurrentHazard ReplayDeliveryPre3406 ReplayDeliveryRace; do
  java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC \
    -deadlock -workers auto -config $cfg.cfg MCReplayDelivery.tla
done
```

(`-deadlock` disables deadlock reporting — fully-delivered quiescent states
are legitimate terminal states. The Pre3406 and Race runs are EXPECTED to
report an invariant violation; that is the point of those configs.)

## Roadmap

- **v2 — close the loop on commands:** model creation events, per-family
  correlation ordinals, the 412 precondition guard, and
  `EntityConflictError` dedup explicitly, so idempotent-concurrent-write
  soundness is checked rather than derived from the lemma.
- **Conformance:** derive implementation test schedules from TLC traces;
  validate assumptions A4/A5 against the real scheduler.
- **Storage-side spec:** a companion module for A1 — reader views of the
  append path are prefix-stable (commit-ordered sequencing, tail-dominant
  ids).
- **Liveness:** the current spec checks safety only; add fairness and check
  that every armed delivery eventually arrives and every run can suspend.
- **TLAPS:** the deterministic-guest lemma and the acyclicity of the
  wait-for graph are short mechanical proofs if we ever want them machine-
  checked.
