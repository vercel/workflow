# eve turns never qualify for spec 9 run-ahead

**Status:** research note, not a decision. **From:** eve latency burndown (Ben Pankow). **Measured:** 2026-11-20, eve main `7105649595` on Workflow 5.7.0 (which eve vendors), spec 9, Vercel (iad1). The code references were checked against `@workflow/core@5.7.0` and `main` at `3e799a40d`.

## Summary

Spec 9 run-ahead introduces the notion of an "inert boundary" (`out-of-band-observation.ts`, #4683): a step boundary where nothing outside the orchestrator can append an event that would change the decision of the workflow state machine. At an inert boundary, run-ahead delivers the outcome of an inline step to the workflow before the `step_completed` for that step commits, and can start the body of the next inline step before its creation commits. Because no other writer can append a path-changing event in between, replay makes the same decisions the speculative run made, even if other events land in between.

eve's turn steps are never marked inert, because every boundary has open steering and cancel hooks. eve is unable to get the speed benefits of run-ahead: each step must wait for `step_completed` to commit, and then for the `step_started` of the next step to commit. These serial writes inflate eve's tool hop by ~150ms, far more than competing frameworks.

When run-ahead is forcibly enabled on eve, latency drops sharply. Measured on a deployed probe agent:

| | Default | Run-ahead forced on |
|---|--:|--:|
| Server: tool result → next model call | 272ms | **124ms** |
| Client: `call.settled` → next text delta | 296ms | **144ms** |
| Client: send → final delta (whole turn) | 874ms | **622ms** |

eve's steering and cancel behaviors are constrained enough that it seems possible for them to coexist with run-ahead.

## Active eve counters

Currently, most eve boundaries have three active counters:

| Counter | eve source | Why eve has it open |
|---|---|---|
| `abortSignal` | `execution/session/turn-control.ts` and `active-turn.ts`: `cancellation` and `steering` `AbortController`s created in workflow code for each turn | So a cancel or a steering message can stop a running turn. However, `abort()` is only ever called from workflow code. |
| `observedHook` | `execution/session-inbox/inbox.ts`: the inbox `pump` keeps an `await iterator.next()` pending on the session hook | So steering and cancel messages are seen mid-turn |
| `waitDue` | `execution/session/program.ts` `stopSandboxOnceIdle`: `host.until()` → `sleep(now + idleTimeoutMs)`, default 300,000ms | Stops a prewarmed or used sandbox once the session is idle. eve abandons it when the next turn starts, but `sleep()` can't be canceled, so the wait stays open until it fires. It counts as due because it falls inside the inline window (5 minutes from the invocation's start for eve's `maxDuration: "max"` flow function) plus the 30s `OPEN_WAIT_CLOCK_SKEW_MS`. |

## eve abort behavior

1. **The abort controllers are in-band only.** Steps only receive `controller.signal` (`turn.ts`: `abortSignal: turn.signal`, `steeringSignal: turn.steeringSignal`), which lets a step see an abort but not trigger one. Only workflow code calls `abort()`. When called, the orchestrator is what writes the `hook_received` in band. Nothing outside the orchestrator can write to these hooks, the same reasoning `out-of-band-observation.ts` uses to treat waits as safe ("no writer other than the orchestrator completes a wait"). The risky case is any step that receives the controller itself, but this is never true for eve.
2. **eve tolerates steering and cancellation after a step starts.** Per eve's execution model, steering that arrives before assistant output begins stops the pending model generation and applies within the same turn. After output starts, it applies at the next step boundary. Cancel interrupts the turn. So if a message lands while the next step has started speculatively, discarding that step and re-deciding with the message is consistent with what eve does today. The hazard run-ahead guards against is log consistency on replay, not eve's semantics: a `hook_received` committing between the speculative writes.
3. **The sandbox idle wait is ignored mid-turn.** The only code that awaits it runs between turns, in `stopSandboxOnceIdle`. eve disables the `idleWindow` when a turn starts, so if the wait fires mid-turn, nothing is listening.

## Proposed Workflow changes

### 1. Treat in-band-only `AbortController` hooks as inert

`isAlwaysObservedHook()` currently returns true for every system hook except the child-run completion hook. It should return false for abort hooks as long as the controller is never serialized for a step or an external caller (the `reviveAbortController` path). The most straightforward way to do this would be an explicit opt-in, such as `new AbortController({ inBandOnly: true })`, with a revived `abort()` throwing. It could also be detected automatically: the workflow-context reducer already handles controllers and signals separately, so it could flag the hook when a controller crosses the boundary.

### 2. Let run-ahead proceed past observed hooks with a conditional commit

Today, observed hooks disable run-ahead. This costs eve the benefit of run-ahead at every boundary, to guard against the small minority of cases where the observed hook actually fires (steering, cancellation). Observed hooks can produce out-of-band writes, which land relative to in-band writes in a way that replays may not match.

Instead of disabling run-ahead at these boundaries, Workflow could run ahead optimistically and have the World reject the speculative writes if anything else was appended in the meantime. Today's in-band fence only counts in-band writes, but the World already tracks a total `seq` it could check against.

If nothing was appended, the workflow state will match the state in a replay, so whatever decision the state machine made optimistically matches the behavior in a replay. In this happy path, the most common case, eve gets the full benefit of run-ahead.

If something did get appended, such as a steering message, the World refuses the writes. The log never enters an incorrect or invalid state. The next step may already have started running. To prevent its side effects from leaking, there are two choices:

- hold the body of the next step until the writes commit, which still saves a round trip; or
- start the body early, but hold back its side-effect writes (stream, attributes) until the commit succeeds. This is the same pattern [workflow #4707](https://github.com/vercel/workflow/pull/4707) uses for the abort hook's creation: start the body, and hold what depends on the commit (there, the step's terminal write).

### 3. Stop a far-off wait from blocking run-ahead

Either:

- **(a)** make `sleep()` cancellable, e.g. `sleep(date, { signal })` writing an in-band `wait_cancelled`, and eve cancels the idle wait when a turn starts; or
- **(b)** count a wait as due only if it can fire before the in-flight run-ahead writes commit (seconds plus skew), not anywhere in the inline window. On spec 9 only the orchestrator writes `wait_completed` (world-vercel refuses an out-of-band one with 409 `wait-completion-in-band-only`), at the top of a pass. Whether a wait firing during run-ahead can safely wait for the next pass is your call; we may be missing a reason for the full window.

(b) needs no API and helps any app with long timers.

## Proof-of-concept PRs

Each proposal has a stacked draft PR. They show one way to implement it, so the trade-offs are concrete. They are not proposals for the final design: the actual choices are for the Workflow team.

- Proposal 1, in-band-only `AbortController` (opt-in): #5658
- Proposal 3 (b), the wait counts as due only within the skew allowance: #5659
- Proposal 2, strict speculative writes past an awaited hook, behind a new `strictEventCount` World capability (test World only): #5660

Proposal 3 (a), a cancellable `sleep()`, is not prototyped: it needs a new event type in every World and in workflow-server.

