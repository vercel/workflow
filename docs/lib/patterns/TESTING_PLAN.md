# Patterns Testing Plan

E2E pipeline + GitHub Actions to guarantee (a) every pattern's code actually
works against the current SDK, and (b) every installable pattern is
installable via the shadcn CLI and the result compiles and runs.

## The root problem this plan solves

Pattern code lives as **template-literal strings** in
`docs/lib/patterns/snippets/*.ts`. Strings aren't typechecked, aren't
executed, and drift silently:

- This PR already chased three drift incidents (the ai-sdk `"use step"`
  misinformation, the child-workflows polling rewrite, DurableAgent
  deprecation) — all were correct when written and rotted as the SDK moved.
- `workbench/vitest/workflows/cookbook/` is a *second*, hand-maintained
  executable copy of (older versions of) the same patterns — already stale
  (`distributed-abort-controller.ts`, `rate-limiting.ts`, `stop-workflow.ts`
  predate the renames; `ai-sdk` isn't there at all).

So the end state is **one source of truth**: real, compiled, tested `.ts`
files, with docs snippet strings *derived* from them. We get there
incrementally — every phase pays for itself even if later phases slip.

## Existing infrastructure to build on (not replace)

| Asset | What it gives us |
|---|---|
| `workbench/vitest` + `@workflow/vitest` plugin | In-process workflow execution in vitest: `start()`, `waitForHook`, `resumeHook`, mocking (see its MOCKING.md). Already wired into `tests.yml` ("Run Vitest Plugin Tests"). |
| `docs-checks.yml` | `Docs Code Samples` (typechecks MDX samples — patterns snippets are NOT covered today) and `Docs Preview Smoke Checks` (waits for the Vercel docs deployment). |
| `app/r/[name]/route.ts` | The registry endpoint to validate and install from. |
| `docs/scripts/lint.ts` | Link checker — model for a new payload-validation script. |
| CI scope detection (`Detect CI Scope`) | Path filtering so patterns jobs only run when relevant. |

---

## Phase A — Registry payload validation (cheap, every PR) ~half day

New script `docs/scripts/validate-registry.ts`, new job in `docs-checks.yml`.

For every `registryItems` entry with `installable !== false`:

1. Build the `/r/[name]` payload (call the route's logic directly — no
   server needed) and assert: ≥1 file, every file non-empty, schema fields
   present, `target` paths under `app/workflows/`.
2. Parse every emitted file with the TS parser — catches template-literal
   escaping bugs (`\${...}` mistakes) and syntax rot that string-land hides.
3. Cross-check manifest `files[]` metadata against actual emitted paths
   (the resend bug — files metadata claiming paths the payload didn't
   contain — becomes structurally impossible).
4. Assert every snippet caption that looks like a path is consistent, every
   `DOCS:` URL in install headers resolves to a real pattern id, and ids in
   `shadcnSlug` match the item id.

**Prerequisite folded in:** add `dependencies?: string[]` to `RegistryItem`
(zod, stripe, resend, ai, @workflow/ai…), emit it in the `/r` payload
(shadcn supports it), validate it by scanning emitted imports — an import
of a non-workspace package missing from `dependencies` fails the check.

## Phase B — Snippet typecheck harness (every PR) ~1–2 days

New script `docs/scripts/typecheck-snippets.ts`, job alongside Phase A
(needs `pnpm build` of packages first — same shape as `Docs Code Samples`).

- Materialize every installable pattern's install payload into a temp
  project per pattern (`app/workflows/*.ts` + the pattern's route/component
  snippets), with a tsconfig resolving `workflow`, `workflow/api`,
  `@workflow/ai`, `zod`, etc. from the built workspace.
- Run `tsc --noEmit` per pattern; report failures per pattern id.
- This is the drift alarm: an SDK signature change that breaks a pattern
  fails the SDK PR, not a future docs reader.

## Phase C — Runtime pattern tests (every PR) ~2–4 days

Extend `workbench/vitest` — the job already runs in `tests.yml`, so new
tests are free infrastructure-wise.

1. Create `workbench/vitest/workflows/patterns/` with executable versions
   of each pattern, and `test/patterns-*.test.ts` suites. Retire the stale
   `workflows/cookbook/` copies as each pattern absorbs them (the old
   names there — distributed-abort-controller, rate-limiting, stop-workflow
   — are exactly the ones we renamed).
2. Behavioral assertions per component (the things hand-review can't prove):
   - **semaphore** — fan out 10 `withPermit(key, 3, …)` calls around an
     instrumented step; assert observed max concurrency ≤ 3, FIFO grants,
     release-on-throw, waiter re-request after a forced coordinator recycle.
   - **rate-limiter** — grant spacing ≥ intervalMs across concurrent runs;
     dead-waiter skip (dispose then assert no interval burned).
   - **circuit-breaker** — trip after N consecutive failures, instant
     rejection while open, single half-open probe, close on probe success,
     re-open on probe failure; fail-open when coordinator absent.
   - **debounce** — burst of K events → exactly one fire with the *latest*
     payload; stale-timer ignored; new burst after fire.
   - **batch-aggregator** — flush at MAX_ITEMS; flush at deadline; id-based
     dedupe (send the same id twice, assert counted once).
   - **singleton-run** — two concurrent `getOrStart` calls → one live run,
     loser returns `{ dedupedTo: winnerRunId }` (getConflict path); mailbox
     ordering.
   - **kill-switch** — `.abort()` from "another process" fires `.signal`;
     racing `create()` calls both end up pointing at the winner's run; TTL
     expiry path.
   - **child-workflows** — `startAndWait` returns the child's value;
     failure propagates as throw; `Promise.allSettled` isolation.
   - **recurring-cron** — drift-corrected `nextDueAt` advancement (short
     intervals), stop hook exits between ticks, continue-as-new hands off
     state exactly once (duplicate-continuation dies on the generation
     token).
   - Templates (polling, DLQ, saga, batching, timeouts, webhooks,
     idempotency) — happy path + one failure path each, with `fetch`
     mocked per MOCKING.md.
3. Time control: prefer the plugin's mocking facilities / short durations
   (the snippets' constants are top-level — the executable copies can take
   them as parameters so tests run in milliseconds).

**Phase C is also the forcing function for canonicalization** (Phase E):
once an executable copy exists, the string snippet is redundant.

## Phase D — shadcn install e2e (every PR touching patterns) ~1–2 days

New job `patterns-install-e2e` in a new `.github/workflows/patterns-e2e.yml`
(path-filtered to `docs/lib/patterns/**`, `docs/app/r/**`, `packages/**`):

1. `next build && next start` the docs app in CI (hermetic — no dependency
   on the Vercel preview; the existing preview-smoke job covers the
   deployed surface).
2. Scaffold one fresh Next.js + workflow app from a committed fixture
   template (`workbench/install-fixture/`, cached), then for every
   installable pattern:
   - `pnpm dlx shadcn@latest add http://localhost:3000/r/<id>` (pin the
     shadcn version for PR determinism; see Phase F for drift coverage)
   - assert the expected files landed at their `target` paths
   - install the pattern's declared `dependencies`
3. One `tsc --noEmit` + one `next build` over the fixture with ALL patterns
   installed — proves the SWC workflow plugin accepts every installed file
   (directive placement, module-scope exports) and that patterns coexist.
4. Smoke run: boot the fixture against the local world and `start()` one
   self-contained workflow (e.g. sequential-and-parallel's pipeline or
   polling with a mocked endpoint) to prove the installed artifacts
   actually execute, not just compile.

## Phase E — Source-of-truth inversion ~2–3 days, after C

Flip the architecture so drift is impossible rather than detected:

- Canonical pattern code lives as real files (natural home: the
  `workbench/vitest/workflows/patterns/` tree from Phase C, or a dedicated
  `docs/lib/patterns/source/` package).
- A codegen step (`pnpm sync-snippets`, enforced by a CI check that the
  working tree is clean after running it) regenerates the snippet string
  modules: display variant = file as-is; install variant = header comment
  block (kept as a sidecar `.header.txt` or front-of-file comment) + body.
- Docs UI and `/r` route are untouched — they keep consuming the generated
  modules.

## Phase F — Nightly deep e2e (cron workflow) ~half day

- Phase D's install matrix, but against **production**
  (`https://workflow-sdk.dev/r/<id>`) and **unpinned** `shadcn@latest` —
  catches live-site regressions and CLI breaking changes without blocking
  PRs.
- Long-duration behaviors with real (short-configured) sleeps: cron
  multi-tick drift, TTL expiry, recycle-under-load soak for the
  coordinators.
- On failure: open/update a tracking issue (mirror `issue-digest.yml`'s
  reporting shape).

---

## Sequencing & ownership of risk

| Phase | Catches | Blocks PRs? | Effort |
|---|---|---|---|
| A — payload validation | broken/empty installs, escaping bugs, metadata lies | yes | ~0.5d |
| B — snippet typecheck | SDK drift at compile level | yes | 1–2d |
| C — runtime tests | semantic regressions, race-handling correctness | yes | 2–4d |
| D — install e2e | CLI installability, SWC-plugin acceptance, build | yes (path-filtered) | 1–2d |
| E — inversion | drift, permanently | n/a (architecture) | 2–3d |
| F — nightly | prod registry, CLI drift, time-dependent soak | no (issue on fail) | 0.5d |

A+B first (immediate safety net, no restructuring). C and D parallelize.
E rides on C. F last.

## Open questions

1. Phase D fixture: one app with all patterns installed (faster, proves
   coexistence) vs per-pattern matrix (better isolation, slower)? Proposal:
   single app on PRs, matrix in the nightly.
2. Where does canonical source live in Phase E — workbench (tests adjacent)
   or docs package (publishing adjacent)?
3. Should Phase B/D failures from *SDK* PRs block those PRs, or post a
   warning? Proposal: block — patterns are shipped product surface.
4. Provider patterns (stripe/slack/resend) in Phase D's smoke run: skip
   runtime (env-gated) or run against mocked endpoints via fetch override?
