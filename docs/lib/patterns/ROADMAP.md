# Patterns Roadmap

Working plan for evolving the `/patterns` page from "19 installable recipes"
into a tiered library of components, templates, and examples.

**Status: phases 0–5 implemented in this PR.** Remaining open items are at
the bottom.

## Guiding taxonomy

Every pattern declares a `patternType`, based on what the installed code is
worth after adaptation:

| Type | The value is… | Archetype |
|---|---|---|
| **Component** | the installed code itself — import it and call it, domain-free | `kill-switch`, `semaphore` |
| **Template** | the structure — keep the skeleton, replace the function bodies | `saga` |
| **Example** | the lesson — read it, then mostly rewrite | `resend`, `stripe` |

"Component" is the bar new patterns should aim for.

---

## Phase 0 — Cleanups ✅

- [x] **Renamed `rate-limiting` → `handling-rate-limits`** (it teaches 429
      handling with `RetryableError`, not rate limiting) — freed the name
      for the real limiter. Redirects added.
- [x] **Renamed `distributed-abort-controller` → `kill-switch`** — v5
      shipped native AbortController support (Cancellation docs), so the
      old name collided. Copy now explains the relationship: KillSwitch is
      the named, durable, cross-process complement. Redirects added.
- [x] **Fixed `resend` install paths** — now follows the `workflows/`
      convention; its `/r` payload previously contained zero files.
- [x] **Tutorials are concept-only** — `sequential-and-parallel` and
      `workflow-composition` are `installable: false`: no Installation
      section, `/r` returns a pointer to the readable page.
- [x] **`provider` category kept** and grown (stripe, slack-approval).

## Phase 1 — Type facet ✅

- [x] Required `patternType: 'component' | 'template' | 'example'` on every
      item; tier badge on cards + detail hero; type filter row on the
      listing page; search matching; copy-page text.

## Phase 2 — Componentize ✅

- [x] **`child-workflows`** now installs two files: the reusable component
      (`workflows/child-workflows.ts` — completion hook,
      `withChildCompletionHook()`, `startAndWait()`) and a worked example.
- [x] **`scheduling`** exposes `cancellableSleep(token, delay)` as its
      reusable core.
- [ ] `agent-cancellation` / `human-in-the-loop` — left as templates; their
      hook mechanics are reusable but tightly woven into the agent
      examples. Revisit if demand shows up.

## Phase 3 — Coordination components ✅

All built on the same architecture: a per-key coordination workflow reading
a single event-channel hook (one consumer → FIFO, no lost messages),
timeouts injected as messages from timer child workflows, senders that
lazily (re)start coordinators, and waiters that self-heal with fresh reply
hooks. `getHookByToken` provides create-or-reconnect.

- [x] **`semaphore`** — `withPermit(key, max, fn)` + `withLock()` mutex
- [x] **`rate-limiter`** — `withRateLimit(key, intervalMs, fn)`, smooth
      spacing limiter
- [x] **`circuit-breaker`** — `withBreaker(key, fn)`, closed/open/half-open,
      fail-open default
- [x] **`debounce`** — `debounceSend(key, payload)`, latest-payload,
      timer-reset via sequence numbers
- [x] **`batch-aggregator`** — `aggregatorSend(key, item)`, flush at N items
      or T elapsed
- [x] **`singleton-run`** — `getOrStart()` / `sendToSingleton()`,
      HookConflictError as the start-dedupe mutex
      (supersedes the `cookbook-resume-hook` branch's recipe — reconcile if
      that branch lands)

## Phase 4 — Templates ✅

- [x] **`polling`** — wait-for-condition with exponential backoff + deadline
- [x] **`dead-letter-queue`** — isolate poison items, redrive later
- [x] **`recurring-cron`** — drift-corrected recurring loop with
      continue-as-new deployment adoption and a clean stop hook

## Phase 5 — Provider examples ✅

- [x] **`stripe`** — dunning (failed-payment recovery) with webhook-driven
      early exit
- [x] **`slack-approval`** — human-in-the-loop with Slack buttons as the
      approval surface

---

## Open items

1. `agent-cancellation` / `human-in-the-loop` componentization (see
   Phase 2).
2. The `/r` registry payload doesn't declare npm `dependencies` (e.g.
   `stripe`, `resend`, `zod`) — shadcn supports a `dependencies` field;
   wire it up from a per-pattern list.
3. Submit the registry to the shadcn registry index so short names work
   (`shadcn add @workflow/semaphore`-style).
4. Consider a `coordination` category if the `advanced` group keeps
   growing.
5. ~~E2E-test the component patterns~~ **Done — see TESTING_PLAN.md.**
   Canonical sources live in `workbench/vitest/workflows/patterns/` with 74
   behavioral tests; docs snippets are generated from them
   (`sync-pattern-source`); every /r payload is validated, typechecked, and
   `next build`-verified in a fixture app; the shadcn CLI install path runs
   in CI per PR and nightly against production. Writing the tests found and
   fixed three shipped bugs: a recurring-cron stop-hook race (stale channel
   awaiters swallowed the stop payload), `deploymentId: "latest"` failing on
   non-Vercel worlds in two patterns, and an SWC transform issue stripping
   module-level consts referenced only by the kill-switch class (also
   latent in the old cookbook copy — possible upstream swc-plugin issue;
   plus a transient world-local `WorkflowRunNotFoundError` worth upstream
   attention).
6. **Idempotency residuals** (analysis in
   [workflow#2376](https://github.com/vercel/workflow/issues/2376)):
   coordinators now claim tokens with `getConflict()` (clean `{ dedupedTo }`
   losers), kill-switch adopts the registered owner's runId after racing
   starts, and the aggregator dedupes by item id — but three gaps need SDK
   support: atomic keyed `start()` (exactly-once child spawns, post-completion
   webhook dedupe), native `resumeOrStart` (replaces every send-with-ensure
   helper), and channel close+drain (closes the aggregator/debounce
   acknowledged-but-dropped flush window).
