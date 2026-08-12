# TLA+ specifications for the workflow engine

Formal models of the Workflow SDK engine, checked with TLC. Each spec
isolates one mechanism the engine's correctness rests on, states the
assumptions it depends on, and pins the intended semantics as an
executable, re-checkable artifact.

## Spec 1: replay delivery ordering and prefix consistency

`ReplayDelivery.tla` models the engine's delivery-ordering discipline and
checks the foundational replay correctness property:

> **Prefix consistency.** For every prefix of the event log, the replay
> engine's suspension output is correct and can be trusted, even if the log
> has grown past that prefix in the meantime: replaying a longer log never
> contradicts the paths, commands, or suspension output derived from any
> shorter prefix — assuming the log is strictly append-only (no events are
> ever inserted between existing events).

### Results

| Config | Setup | Result |
| --- | --- | --- |
| `ReplayDelivery.cfg` | Barrier discipline, full-featured 6-event schedule | ✅ PrefixConsistency + Determinism hold (exhaustive) |
| `ReplayDeliveryUnreadHook.cfg` | Barrier discipline, minimal unread-buffered-payload schedule | ✅ hold (exhaustive) |
| `ReplayDeliveryNoBarriers.cfg` | Discipline removed (falsifiability check) | ❌ PrefixConsistency violated, as expected — shows the invariants have teeth and the discipline is what discharges them |

### What is modeled

The model reduces the engine to the one mechanism the theorem hinges on:
**in which order do event-log resolutions become visible to workflow
code?** The reduction is justified by a factoring lemma:

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
log grows". The two invocations also **pace independently** — one may
consume events incrementally with idle gaps (a live invocation) while the
other consumes the full window before delivering (a cold replay) — so the
invariants also rule out live-vs-replay wake-order divergence.

### Model ↔ code map

| Model element | Code (packages/core/src) |
| --- | --- |
| `Consume(i)` — strict in-log-order consumption | `events-consumer.ts` `EventsConsumer.consume` / `eventIndex` |
| `Schedule[e].kind ∈ {hook, wait, step}` | branch-deciding deliveries: `hook_received`, `wait_completed`, `step_completed/failed` (`private.ts` `DeliveryKind`) |
| `DeferBehind` | `private.ts` `DEFER_BEHIND` |
| `GatesOn(i, e, j)` | `private.ts` `gatesOn`: a step skips an unarmed entry (unclaimed buffered payload) directly, never transitively |
| `Blocked(i, e)` | `private.ts` `awaitEarlierDeliveries` (evaluated as an arrival-time gate; see caveats) |
| `SelfRes(i, e)` | `private.ts` `resolvesOnItsOwn` / `computeResolvesOnItsOwn` (shares `GatesOn` with `Blocked`, exactly as the implementation shares `gatesOn`) |
| `Schedule[e].armed`, `Claim(i, e)`, `ArmedNow` | `DeliveryBarrierEntry.armed`, `arm()`, and the buffered-payload claim path in `workflow/hook.ts` (claim-time barrier snapshot) |
| `RetireAtIdle(i, e)` | `registerDeliveryBarrier`'s idle safety net (`scheduleWhenIdle` → `finish()`) |
| `Idle(i)` | `scheduleWhenIdle`'s check: `pendingDeliveries == 0 ∧ ¬hasParkedCommittedDelivery` |
| `SuspensionPoint(i)` | an accepted `WorkflowSuspension` (idle check stable, nothing armed still parked) |
| nondeterministic choice among enabled `Arrive`s | variable microtask-hop counts between a delivery's `resolve()` and guest observation (hydration, decryption, iterator wrappers, replay-cache memo hits) |
| `Barriers = FALSE` | delivery with no ordering discipline (falsifiability check; also models any code path that routes around `awaitEarlierDeliveries`) |

### Assumptions

- **A1 — append-only log.** Events are only ever appended; every reader
  observes a prefix. No interior insertion, no reordering. (Discharged
  operationally by the storage layer; a storage-side spec is future work.)
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
  count thresholds are the special case sufficient to exercise the
  discipline (any content-dependent claim function is expressible by
  extending the schedule constant).
- Creation events, hook conflicts/disposal, aborts, streams, retained-VM
  sessions, and the 412 precondition guard on suspension writes are not
  modeled (see Roadmap).

## Files

- `ReplayDelivery.tla` — the model (log consumption, barrier discipline,
  claims, idle retirement, invariants). Extensively commented with code
  references.
- `MCReplayDelivery.tla` — concrete schedules (`SafeSchedule`,
  `UnreadHookSchedule`, `RaceSchedule`).
- `ReplayDelivery.cfg`, `ReplayDeliveryUnreadHook.cfg`,
  `ReplayDeliveryNoBarriers.cfg` — the experiments from the results table.

## Running

Requires Java and `tla2tools.jar` (gitignored):

```bash
cd specs/tla
curl -sLO https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar
for cfg in ReplayDelivery ReplayDeliveryUnreadHook ReplayDeliveryNoBarriers; do
  java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC \
    -deadlock -workers auto -config $cfg.cfg MCReplayDelivery.tla
done
```

(`-deadlock` disables deadlock reporting — fully-delivered quiescent states
are legitimate terminal states. The NoBarriers run is EXPECTED to report an
invariant violation; that is the point of that config.)

## Roadmap

- **Close the loop on commands:** model creation events, per-family
  correlation ordinals, the 412 precondition guard, and
  `EntityConflictError` dedup explicitly, so idempotent-concurrent-write
  soundness is checked rather than derived from the lemma.
- **Conformance:** derive implementation test schedules from TLC traces;
  validate assumptions A4/A5 against the real scheduler.
- **Storage-side spec:** a companion module for A1 — reader views of the
  append path are prefix-stable.
- **Liveness:** the delivery spec checks safety only; add fairness and
  check that every armed delivery eventually arrives and every run can
  suspend.
- **TLAPS:** the deterministic-guest lemma and the acyclicity of the
  wait-for graph are short mechanical proofs if we ever want them machine-
  checked.
