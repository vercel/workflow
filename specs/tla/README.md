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

## Spec 2: dispatch-layer self-healing

`SelfHealing.tla` models the dispatch layer — what a suspension pass
enqueues, how the queue's idempotency dedup treats those enqueues, and
what an adversary can lose — and checks the design claim:

> **Self-healing.** If a run is stuck at any point after creation (every
> queue message driving it lost — crash, prune, TTL), enqueueing one
> replay of the event log rehydrates every queue message the run needs to
> continue making progress. The event log is the source of truth; queue
> messages are reconstructible cache.

The run is abstracted to a set of pending entities, each needing one
driver message: a pending step needs a step-dispatch message
(`runtime.ts`, `idempotencyKey = step.correlationId`) and a pending wait
needs a delayed continuation (`runtime/wait-continuation.ts`, key seeded
from the wait's correlationId — the bare correlationId for mid-range
waits). The property is encoded as a safety postcondition on every replay
pass: *no pass may finish leaving a pending entity with neither a
resolution nor a driver message in flight* (`SelfHealSound`).

### Results

| Config | Setup | Result |
| --- | --- | --- |
| `SelfHealing.cfg` | Entity-keyed driver messages (shipping discipline) + dedup records that outlive their messages (documented world behavior) | ❌ **SelfHealSound violated** — see below |
| `SelfHealingVolatileDedup.cfg` | Same keying, but message loss also forgets the dedup record | ✅ holds |
| `SelfHealingAttemptKeys.cfg` | Keys include the replay-pass ordinal, dedup records survive loss | ✅ holds (at the cost of the one-message-per-entity collapse) |

### The hole

The minimal witness TLC produces (5 states, one wait + one step pending):

1. The initial replay pass enqueues both driver messages, burning keys
   `⟨wait⟩` and `⟨step⟩` into the queue's idempotency memory.
2. The step executes and wakes the orchestrator.
3. The wait's continuation message is **lost** (prune / crash / TTL). Its
   idempotency record survives — `wait-continuation.ts` documents exactly
   this: "VQS keeps idempotency records until message-retention TTL;
   world-postgres keeps a completed-keys cache", so "a later enqueue under
   the same key is silently dropped".
4. The next replay pass (the step-completion wake — or, identically, a
   manual healing replay) re-observes the pending wait, derives the *same*
   key, and its re-enqueue is silently absorbed. The pass ends with an
   empty queue and an unresolved wait.

No number of further healing replays helps: each derives the same key.
The run stays stuck until the wait's deadline passes **and** something
else wakes it (a heal after the deadline resolves the wait directly via
the elapsed-waits pass), or until the dedup record expires. Single-shot
self-healing therefore does not hold under the shipping keying discipline
whenever dedup records can outlive the messages they deduplicate — for
step dispatch and mid-range wait continuations alike. (The near-elapsed
and multi-hop wait keys vary with time/hop and partially escape; the bare
keys do not.)

The two passing configs pin down the fix space: make loss erase the dedup
record (a queue-semantics fix — e.g. a prune that also purges idempotency
state), or vary the key across passes (a keying fix — trading away the
duplicate-message collapse the dedup exists to provide; a real design
would scope the variation narrowly, e.g. only for explicit heal-mode
replays).

### Assumptions

- **B1** — the entities' `*_created` events are durable in the log (that
  is what makes them reconstructible by a replay at all).
- **B2** — replay passes are atomic (the suspension handler settles all
  writes and dispatches before acking).
- **B3** — a healing replay reaches pre-existing steps through the keyed
  "immediate enqueue" path, not inline execution
  (`createdStepCorrelationIds` gating: only the handler that wrote
  `step_created` inlines it).
- **B4** — the wait/step delivery itself always wakes the orchestrator
  (queue-handler behavior, not modeled further).

## Files

- `ReplayDelivery.tla` — the delivery-ordering model (log consumption,
  barrier discipline, claims, idle retirement, invariants). Extensively
  commented with code references.
- `MCReplayDelivery.tla` — concrete schedules (`SafeSchedule`,
  `UnreadHookSchedule`, `RaceSchedule`).
- `ReplayDelivery.cfg`, `ReplayDeliveryUnreadHook.cfg`,
  `ReplayDeliveryNoBarriers.cfg` — the spec 1 experiments.
- `SelfHealing.tla` — the dispatch-layer model (driver messages,
  idempotency dedup, adversarial loss, healing replays).
- `MCSelfHealing.tla` — the one-wait-one-step entity set.
- `SelfHealing.cfg`, `SelfHealingVolatileDedup.cfg`,
  `SelfHealingAttemptKeys.cfg` — the spec 2 experiments.

## Running

Requires Java and `tla2tools.jar` (gitignored):

```bash
cd specs/tla
curl -sLO https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar
for cfg in ReplayDelivery ReplayDeliveryUnreadHook ReplayDeliveryNoBarriers; do
  java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC \
    -deadlock -workers auto -config $cfg.cfg MCReplayDelivery.tla
done
for cfg in SelfHealing SelfHealingVolatileDedup SelfHealingAttemptKeys; do
  java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC \
    -deadlock -workers auto -config $cfg.cfg MCSelfHealing.tla
done
```

(`-deadlock` disables deadlock reporting — fully-delivered quiescent states
are legitimate terminal states. The `ReplayDeliveryNoBarriers` and
`SelfHealing` runs are EXPECTED to report an invariant violation; that is
the point of those configs.)

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
