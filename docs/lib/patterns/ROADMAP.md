# Patterns Roadmap

Working plan for evolving the `/patterns` page from "19 installable recipes"
into a tiered library of components, templates, and examples. Iterate on this
doc directly — check things off, reorder, strike out, add.

## Guiding taxonomy

Every pattern is one of three types, based on what the installed code is
worth after adaptation:

| Type | The value is… | Archetype |
|---|---|---|
| **Component** | the installed code itself — import and call, domain-free | `distributed-abort-controller` |
| **Template** | the structure — keep the skeleton, replace the function bodies | `saga` |
| **Example** | the lesson — read it, then mostly rewrite | `resend` |

Components install to `lib/`, templates to `workflows/`, examples wherever
fits the integration. "Component" is the bar new patterns should aim for.

---

## Phase 0 — Cleanups (small, do anytime)

- [ ] **Rename `rate-limiting`** → it teaches 429-handling with
      `RetryableError` + backoff, not rate limiting. New name candidates:
      `handling-rate-limits`, `retry-with-backoff`. Add redirect from the old
      slug. Frees the `rate-limiting` name for a real limiter (Phase 3).
- [ ] **Fix `resend` install paths** — installs to
      `app/workflows/providers/resendWorkflow.ts`; every other pattern uses
      `workflows/<id>-workflow.ts`. Make consistent.
- [ ] **De-emphasize install for pure tutorials** —
      `sequential-and-parallel` and `workflow-composition` install only
      placeholder code. Keep the pages, but consider hiding/downplaying the
      install CTA (e.g. render as "Concept" pages).
- [ ] **Decide fate of `provider` category** — currently a category of one
      (resend). Either grow it (Phase 5) or retitle resend as
      "Email sequences" under `common`.

## Phase 1 — Type facet in the UI

Mirror the `versions` badge work:

- [ ] Add `patternType: 'component' | 'template' | 'example'` to
      `RegistryItem` (required, like `versions`).
- [ ] Classify all 19:
  - component: `distributed-abort-controller`
  - template: `saga`, `batching`, `webhooks`, `idempotency`, `timeouts`,
    `upgrading-workflows`, `ai-sdk`, `durable-agent`, `child-workflows`,
    `scheduling`, `agent-cancellation`, `human-in-the-loop`
    (last four graduate to component after Phase 2)
  - example: `rate-limiting`*, `sequential-and-parallel`,
    `workflow-composition`, `sandbox`, `chat-sdk`, `resend`
- [ ] Badge on card + detail hero; filter row on the listing page.
- [ ] Include in copy-page text and search matching.

## Phase 2 — Componentize what's already half-generic

Extract the generic machinery into `lib/` files; the example workflow
imports them instead of inlining.

- [ ] **`child-workflows`** → `lib/child-workflows.ts` exporting
      `startAndWait()`, `withChildCompletionHook()`, `completionToken()`;
      example parent/child stays in `workflows/`.
- [ ] **`scheduling`** → `lib/scheduled-action.ts`: generic
      deferred-cancellable-action (durable sleep raced against a cancel
      hook), parameterized over the action.
- [ ] Evaluate same split for **`agent-cancellation`** (stopHook race) and
      **`human-in-the-loop`** (approval hook + card are already reusable;
      maybe just relabel as component once typed).

## Phase 3 — New components (the coordination-primitives family)

All buildable on the coordination-workflow + hooks trick the abort
controller demonstrates. Each installs a `lib/` class/helper + a small demo.

Priority order:

- [ ] **Semaphore / concurrency limiter** — "at most N running across all
      workers."
- [ ] **Distributed lock / mutex** — single-flight per key.
- [ ] **Singleton run (`resume-or-start`)** — `getOrStart(key)` dedupe.
      ⚠ Blocked on the `cookbook-resume-hook` branch landing on main;
      port it as a pattern when it does.
- [ ] **Rate limiter (real one)** — token bucket / sliding window.
      Takes over the `rate-limiting` slug after the Phase 0 rename.
- [ ] **Circuit breaker** — open after N failures, half-open probe,
      wraps any step.
- [ ] **Debounce / throttle by key** — "at most one notification per user
      per hour," collapse bursts.
- [ ] **Batch aggregator / buffer** — inverse of `batching`: accumulate
      events via hook until N items or T minutes, then flush. Uniquely
      suited to a durable runtime — good showcase.

## Phase 4 — New templates

- [ ] **Wait-for-condition / poller** — poll external system with backoff +
      timeout until a condition holds.
- [ ] **Dead-letter queue** — after retries exhaust, persist failure and
      continue the batch. Companion to saga/batching.
- [ ] **Recurring cron loop** — self-rescheduling recurring workflow using
      the `upgrading-workflows` continuation trick for long-lived runs.
      (Current `scheduling` is one-shot deferred, not recurring.)

## Phase 5 — Provider examples (only if `provider` category stays)

- [ ] **Stripe** — payment lifecycle / dunning via webhook request-reply.
- [ ] **Slack approval** — human-in-the-loop with Slack as the approval
      surface instead of a React card.

---

## Open questions

1. Naming for the renamed 429 pattern (`handling-rate-limits` vs
   `retry-with-backoff`)?
2. Should tutorials (`sequential-and-parallel`, `workflow-composition`)
   remain installable at all, or become non-installable "Concept" pages?
3. Grow `provider` (Stripe/Slack) or fold resend into `common`?
4. For Phase 3 components: one shadcn item per primitive, or a single
   `workflow-primitives` bundle?
5. Does this roadmap doc stay in the repo (and the PR) or move to an issue?
