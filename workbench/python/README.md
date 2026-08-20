# Python workbench app

A Python implementation of the workflow app side, so `packages/core/e2e/e2e.test.ts`
has something other than JavaScript to run against. The test driver stays in
TypeScript — one source of truth for what the protocol is — and this app is the
second implementation it drives.

Built on [vercel-py](https://github.com/vercel/vercel-py), pinned by commit in
`pyproject.toml`: one `[tool.uv.sources]` entry for the umbrella `vercel`
package. The only code this app imports is `vercel.workflow`, which since
vercel-py#299 is its own `vercel-workflow` distribution — but depending on that
name directly puts `@vercel/python` in workers mode and silently unsubscribes
the deployment from the queue, so the umbrella stays until the builder learns
the split — the note above the dependency has the detail. Everything but
`vercel` itself therefore resolves from PyPI, the runtime
included; the note above the source entry says how to check that what you got
matches the rev you asked for. Bump the rev deliberately, and re-run the suite
when you do.

## Running it

```bash
cd workbench/python
uv sync --locked
WORKFLOW_PUBLIC_MANIFEST=1 pnpm dev     # uvicorn on :3000
```

Both of those guard the lock against your personal `~/.config/uv/uv.toml`
(`--locked` refuses to rewrite it, and `pnpm dev` passes `--no-config` to
`uv run`, which re-locks on startup otherwise). If you find an `[options]` block
at the top of `uv.lock`, something ran uv without one of them and CI will reject
the result — the note above `[tool.uv.sources]` in `pyproject.toml` has the rest,
including how to bump the pin.

Then, from the repo root:

```bash
DEPLOYMENT_URL="http://localhost:3000" APP_NAME="python" \
  pnpm vitest run packages/core/e2e/e2e.test.ts
```

Both sides talk to the same `world-local` data directory
(`WORKFLOW_LOCAL_DATA_DIR`, defaulting to `.workflow-data` here) with
byte-compatible file formats, so the TypeScript CLI can inspect runs the Python
app produced:

```bash
cd workbench/python && node ./node_modules/workflow/bin/run.js inspect --json runs
```

## Running it against the Vercel world

Both sides are wired: the `workbench-python-workflow` project is rooted at
`workbench/python` and Git-connected, and the `e2e-vercel-prod` matrix carries a
`python` row (excluded from the `quickjs` VM axis, which is a JS-engine dimension
with no Python meaning). What makes the build work:

- `vercel.json` declares `pyproject.toml` as the build src. That is what puts
  `@vercel/python` in "declared-only" mode — without it the `[tool.vercel]`
  keys are ignored, because the builder only attaches workflows to recognised
  Python frameworks or to declared builds, and a bare ASGI app is neither.
- That `use` carries an **explicit builder version**, which the other workbench
  projects do not need. An unpinned `use` resolves to whatever `@vercel/python`
  ships inside the Vercel CLI the build platform happens to run, and that lags
  npm — builds were picking up 6.53.0 (CLI 58.1.0) well after 6.55.x was out.
  6.53.0 predates queue mode, so the builder silently fell back to "workers"
  mode and pointed the workflow function straight at `app:registry`. That is a
  `Workflows` object, not an ASGI callable, so every queue delivery 500'd with
  `Could not determine the application interface for 'app:registry'` — the run
  was created, the message was delivered, and nothing ever executed. Everything
  below about consumer groups depends on queue mode, so the pin is what makes it
  reachable at all. Bump it deliberately.
- `[tool.vercel] entrypoint = "app:app"` builds the web function. On Vercel it
  serves exactly one useful route, `manifest.json`. Runs arrive over the queue,
  so the hand-written `POST /flow` adapter is dead code there — it is how the
  *local* world delivers, and only that.
- `[[tool.vercel.workflows]] entrypoint = "app:registry"` builds the workflow
  function. At build time the builder imports `app`, reads
  `vercel.queue.get_subscriptions()`, and writes one `queue/v2beta` trigger per
  subscription. You can run that introspection yourself, exactly as the builder
  does:

  ```bash
  VERCEL=1 VERCEL_REGION=iad1 VERCEL_DEPLOYMENT_ID=dpl_introspection \
    uv run python -c 'import importlib; importlib.import_module("app")
  from vercel.queue import get_subscriptions
  print([(s.topic, s.consumer_group) for s in get_subscriptions()])'
  # [('__wkf_workflow_*', 'default')]
  ```

  One topic, not two: since vercel-py #251 a step invocation rides the workflow
  topic as a `stepId` on the invoke payload, the way the TypeScript SDK does it.

  `default` is the point. It is the consumer group `createWorkflowQueueTrigger`
  writes for the TypeScript SDK on the same topics, which is what makes the
  platform deliver to a Python consumer at all. Getting there needed
  vercel/vercel#17236 (`@vercel/python` 6.54.0), which replaced a consumer name
  derived from the output path with the introspected one.

  Reaching queue mode at all has a second, blunter condition: the builder looks
  for the literal name `vercel` in `[project].dependencies` and then reads
  `importlib.metadata.version("vercel")`, requiring >= 0.8.0. Both halves name
  the umbrella distribution, so declaring only `vercel-workflow` — the package
  that actually holds the runtime since vercel-py#299 — drops the build back to
  workers mode. That failure is quieter than the 6.53.0 one above: the trigger
  is written for consumer `app_registry` on `__wkf_*` rather than `default` on
  `__wkf_workflow_*`, so deliveries do not 500, they never arrive. Every run
  times out with zero requests logged against it. No released builder knows the
  new name (checked through 6.56.2).

`.python-version` pins 3.14 so the deployed interpreter matches the local venv;
the builder would otherwise default to 3.12.

The project also needs a `VERCEL_WORKFLOW_SERVER_URL` env var scoped to
**Preview**, with the same value every other workbench project has. On a PR the
`e2e-vercel-prod` job points the *driver* at a branch workflow-server
(`tests.yml:484`); without the matching variable on the project the deployed app
keeps writing to production `vercel-workflow.com`, and the two sides end up on
different primary stores. vercel-py reads it in
`vercel/workflow/_internal/worlds/vercel.py`. Production runs need nothing: the secret
resolves to `''` on `main`, so both sides use `vercel-workflow.com`.

That variable is about the *app* reaching the right store, and pointing it at the
branch workflow-server (`e2e.vercel-workflow.com`) means clearing that server's
deployment protection. Two callers need to, and they need it differently.

The *driver* clears it with the workbench project's own identity, so
`workbench-python-workflow` had to be listed in **that** project's Trusted
Sources alongside the JS workbench projects. It now is: driver writes land, and
runs are created. Before that, every write failed with `v4 createEvent: response
missing required x-wf-* headers` and a `SyntaxError: Unexpected token '<'` — the
HTML SSO page, not a workflow-server response.

The *app* clears it with a header, and until `vercel-py#278` vercel-py did not
send that header. `getHttpConfig` (`packages/world-vercel/src/utils.ts:366`) sets
both `Authorization: Bearer <oidc>` **and**
`x-vercel-trusted-oidc-idp-token: <oidc>`; vercel-py's `_cbor_request` set only
the first. Trusted Sources reads the second, so the very first call the workflow
handler made — `runs_get`, before any replay — came back `302` to the SSO page,
and every delivery 500'd:

```
HTTP Request: GET https://e2e.vercel-workflow.com/api/v2/runs/wrun_... "HTTP/1.1 302 Found"
  File ".../worlds/vercel.py", line 219, in _cbor_request
    result = resp.json()
json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)
cbor2.CBORDecodeEOF: premature end of stream
```

That the redirect surfaced as a CBOR decode error rather than as "you were
redirected to a login page" was a second bug in the same function: it parsed the
body before checking the status. Both are fixed in the pinned rev — the auth
headers now split proxy from direct the way `getHttpConfig` does, and a non-2xx
derives its error from the status before the body is touched.

Production runs are unaffected on both counts: the secret is `''` on `main`, so
each side talks to `vercel-workflow.com`, which is not protected.

CI reaches *this* deployment past deployment protection through the project's
`trustedSources.oidcProviders` entry for `token.actions.githubusercontent.com`.
A `trustedSources.projects` entry would additionally let a locally pulled
`VERCEL_OIDC_TOKEN` in; the other workbench projects have one, this project does
not need it for CI.

The divergences that bite are catalogued in vercel-py's queue notes — region
routing, no delivery cap, and a one-second floor on immediate re-enqueues.

The one that used to block this lane outright was the queue transport. Once
queue mode was reached, every delivery 500'd on `UnicodeDecodeError: 'utf-8'
codec can't decode byte 0xb9` → `MessageCorruptedError`. `0xb9` is CBOR:
`@workflow/world-vercel` publishes the invoke payload with `CborTransport`
(`packages/world-vercel/src/queue.ts:34`) whenever the run's `specVersion >= 3`,
and the run's spec version comes from whoever *created* it. Here that is the
TypeScript driver, stamping 5 from `world-vercel`'s own `specVersion`, so
Python's declared 2 never enters the decision. vercel-py had only a JSON
consumer path. Nothing in this repo could override either side without pinning
the lane to a legacy spec version, which would have made the one lane testing
the current protocol the one lane not testing it.

vercel-py fixed it in two parts, spanning two packages: `vercel-py#265` attaches
a CBOR-with-JSON-fallback transport to the workflow topic, and `vercel-py#266`
taught `Topic` / `TopicPattern` to carry a codec in the first place. That is why
the pin briefly needed a second `[tool.uv.sources]` entry — `vercel-queue` 0.8.0
carries #266, so PyPI is enough again. Attaching it to the *subscription* rather than to a
client is what makes it work when deployed — the function that receives a push
delivery is the builder-generated `_vc_queue_handlers/<name>.py`, whose
`vercel.queue.asgi_app()` constructs its own `QueueClient` with no arguments, so
a transport set on the world's client would never have been consulted.

Confirmed fixed against a real deployment: on `36d5763a` the invoke payload
decodes and the workflow handler runs, which is how the protection-header gap
above became visible at all — it is the next call the handler makes.

`world-local` was never affected — Python is producer and consumer there, so
JSON on both ends is self-consistent.

Behind that sat one more, and it is why `cryptography` has to be installed. On
Vercel the run input is
written by the *driver*, and `@workflow/world-vercel` encrypts every payload it
can resolve a per-run key for — which on a deployment is all of them, with no
opt-out env var or config flag. Each run therefore arrived as an `encr`
envelope and died at the first hydration of its input, before any fixture code
ran:

```
SerializationError: the input of run wrun_... uses the 'encr' format,
                    which this SDK cannot read
```

vercel-py added read support in `vercel-py#279`: HKDF-SHA256 over the
deployment secret (32 zero salt bytes, `info = "<projectId>|<runId>"`) to
derive the per-run key, then AES-256-GCM over `[nonce 12][ciphertext+tag]`.
The plaintext carries its own format prefix, so it re-enters `hydrate` as the
`devl` payload it would have been. AES-GCM comes from `cryptography`, which
`vercel-workflow` now requires outright; while the runtime lived in `vercel` it
sat behind an `encryption` extra this app had to remember to ask for, and
forgetting it produced the same failure with a message naming what to install.

Reading is all this app needs. Python still writes plain `devl`, and the
TypeScript reader passes non-`encr` payloads through untouched
(`maybeDecrypt`, `packages/core/src/serialization/encryption.ts:284`), so the
two sides interoperate without Python ever encrypting anything. `encp`, the
X25519 sealed-box format one run uses to write to another, became readable in
`vercel-py#297`; nothing in the suite produces one either way.

Again `world-local` is exempt — no deployment key, nothing to derive from, so
the local lane could never have caught this. It is the clearest case so far of
why the Vercel lane earns its keep.

The last one arrived from this repo rather than being found here. #3389 gave
`world-vercel` `specVersion: 6` (slot-numbered event ids), so every run the
driver creates is stamped 6, while vercel-py typed the field as
`Literal[1, 2, 3, 4, 5]` on the shared event base. The write itself succeeded —
it was parsing the `200` that raised. vercel-py now splits the two meanings the
way TypeScript does: `SPEC_VERSION_CURRENT` stays 2 (what Python stamps) and
`SPEC_VERSION_MAX_SUPPORTED` is 6 (what Python will read), which is what keeps
version 7 from being the same outage. `world-local` is on 5, so once more only
the deployed lane saw it.

Slot ids themselves need nothing from Python: a slot body is 26 zero-padded
decimal digits, which every ULID validator already accepts and which sorts the
same way. The one thing that breaks is decoding a timestamp out of an event id,
and vercel-py never does — it mints ids only for `world-local`.

The last one only ever showed up here, and it read as flakiness for two rounds
before it read as a bug: one arbitrary run per suite died with `WorkflowWorldError:
workflow run wrun_… not found` about 400ms after `start()`, the queue did not
redeliver, and the driver sat out its 60-second timeout. A different fixture each
time, which is what made it look random. It is not: `start()`
(`packages/core/src/runtime/start.ts:577`) issues `run_created` and the queue push
**in parallel**, deliberately — "if events.create fails with 429/5xx, the run was
still accepted via the queue" — so a consumer that finds no run row has found a
normal state, not an error one. The TypeScript consumer never reads the row at
all: it writes `run_started`, which is idempotent and creates the run when
`run_created` was never seen, and takes the run entity out of that response.
vercel-py had it the other way round (`runs_get`, then `run_started` only if
`status == "pending"`) and 500'd on the 404, and it dropped the `runInput` the
message carries for exactly this purpose — input, deployment id, workflow name,
spec version, attribute seed. `vercel-py#282` carries `runInput` through,
`#284` bootstraps from `run_started`, and `#283` gives `world-local` the same
resilient start. Which is also what retired this app's last `unsupported` entry,
the deterministic version of the same defect: *resilient start: addTenWorkflow
completes when run_created returns 500* deletes the row on purpose.

`world-local` did have the race, and could never lose it: both writes are local
files in one process while the queue delivery takes an HTTP round trip, so
`run_created` always won.

## Conformance baseline

What the suite runs here is declared in `e2e-conformance.json`: the ported
fixtures, and — when there is one — an `unsupported` map naming individual tests
whose failure is a runtime gap rather than a missing fixture. There is none right
now. Both axes are ratchets: a claim that stops being true fails the run instead
of quietly skipping, so growing the file is the only way to move.
`ConformanceConfig` in `packages/core/e2e/utils.ts` spells out each direction.

Current baseline: **9 passing, 128 skipped, of 137** on `world-local`, and
**8 of 156** on Vercel. It is one baseline, not two — the extra 19 collected on
Vercel are `e2e-agent.test.ts`, which that lane also picks up and skips whole,
and the ninth pass is `deploymentId: 'latest' is a no-op in non-Vercel worlds`,
which is local by definition.

## What is missing

This app is honest about being early. In rough order of how much it costs:

- **Most fixtures are simply not ported yet** — 66 tests across 52 fixtures.
  They are not blocked on one thing anymore: the largest blocks are hooks (19
  tests, where vercel-py's `BaseHook.wait()` has a different shape than the
  async-iterable hook the fixtures use), streams (11, where vercel-py now has
  `read_stream` / `get_writable` and nothing here uses them yet),
  `setAttributes` (9, no Python equivalent), and `FatalError` /
  `RetryableError` (7 — `FatalError` is exported now, `RetryableError` has no
  Python counterpart at all).
- **The `.well-known/workflow/v1` surface lives in `app.py`, not the SDK**, and
  reaching it needs three `vercel.workflow._internal` imports
  (`workflow_entrypoint`, `FLOW_ROUTE`, and the `HTTPRequest` base), none of
  which has a public equivalent. The module docstring explains why that surface
  belongs in the app.
- **The health-check tests stay JS-only, but no longer for want of an
  implementation.** vercel-py answers both probes as of `vercel-py#292` — the
  `?__health` one inside `workflow_entrypoint` (so `app.py` only routes to it)
  and the queue-based one in `workflow_handler`. What the driver additionally
  asserts is a `workflowCoreVersion` string, which Python deliberately omits
  because it names a JavaScript package's version and the reader feeds it to
  that package's capability tables. Moving the three tests across means deciding
  what a non-JS SDK should report there.
- **No webhook route and no app-specific API routes**, so the webhook and
  direct-step-call tests are JS-only too.

Two things in `workflows/99_e2e.py` look like mistakes and are not — a module
name starting with a digit, and Python functions in camelCase. Its docstring
says why both are load-bearing; don't "fix" either without reading it.
