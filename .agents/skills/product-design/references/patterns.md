# Patterns

Cross-cutting copy patterns not tied to one component. Load when reviewing flows or surface choices, not single components.

> **Editing this surface?** Start at [`SKILL.md` → Workflow](../SKILL.md#workflow), then load the matching entry in [`surfaces.md`](surfaces.md).

## Contents

- [Patterns](#patterns)
  - [Contents](#contents)
  - [Error Messages](#error-messages)
    - [Known-State 404 Recovery](#known-state-404-recovery)
    - [Upstream / Partner Errors](#upstream--partner-errors)
  - [Stable Identifiers](#stable-identifiers)
  - [Incident \& Status-Page Copy](#incident--status-page-copy)
  - [Async Operation States](#async-operation-states)
    - [Retry \& Scheduled States](#retry--scheduled-states)
  - [Stalled But Not Failed](#stalled-but-not-failed)
  - [Destructive Copy Patterns](#destructive-copy-patterns)
  - [Toast Surface Selection](#toast-surface-selection)
    - [Toast Event Semantics](#toast-event-semantics)
    - [Hybrid: Toast + Persistent Surface](#hybrid-toast--persistent-surface)
  - [Permission \& Access Copy](#permission--access-copy)
    - [Cross-Tenant Denials](#cross-tenant-denials)
    - [Third-Party Integration Auth Failures](#third-party-integration-auth-failures)

## Error Messages

Formula: **what happened + what to do next.** Be specific. `Something went wrong. Try again.` is a last resort.

| ✅                                                                            | ❌                                                             | Why                                   |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------- |
| `That code is invalid. Try again.`                                            | `The code entered is invalid.`                                 | Active; recovery added                |
| `Couldn’t verify your passkey. Try again.`                                    | `Unable to verify passkey. Please try again.`                  | Active; no `please`                   |
| `Build failed — bundle exceeds 50 MB. Reduce your bundle or raise the limit.` | `An error occurred during the build process.`                  | Specific cause, specific fix          |
| `That recovery code is invalid or already used.`                              | `The recovery code you entered has been used or is incorrect.` | Shorter; subject first                |
| `Something went wrong. Try again.`                                            | `An error occurred. Please try again.`                         | Fallback, but shorter and no `please` |

Surface choice is part of the error. Put the message where the user can act:

- **Field or import validation:** inline next to the input/dropzone. The error names the failing constraint or artifact. `Couldn’t import design system. The Figma file is private or unavailable.` beats a generic toast.
- **Section load failure:** keep the surrounding page stable and show an inline error in that section. Pair with `Try Again` and a stable ID when it’s a platform/system failure.
- **Billing, permission, deploy, or data-loss blockers:** never toast-only. Toast may announce the event; the persistent surface carries the reason, route, and ID if applicable.
- **Full-page error:** use a route-level error page only when the whole route can’t render or the user has no useful page context left.

**Inline form errors:** pass a string or error object to Input’s `error` prop; the surrounding state (`setError`, `validationError`, etc.) is the caller’s. Sentence case, end with a period.

```tsx
const validationError = hasValidationFailed
  ? 'That code is invalid. Try again.'
  : null;
setError('Code must be 6 digits.');
```

**Error-code → message maps** (`lib/get-login-error.ts` and similar): one canonical short message per code, no “please,” active voice.

- **Don’t make the user re-enter what they already typed.** If validation fails, preserve their input. Re-render the field with the value intact and the error inline; never blank the input on validation error.

For form-field validation specifics (when to name the exact constraint vs. generic fallback), see [surfaces.md → Form controls](surfaces-forms.md#form-controls-inputs-selects-comboboxes-searchinputs).

For interpolated counts (`{n} blob` vs `{n} blobs`), see [mechanics.md → Plural and Singular Agreement](mechanics.md#plural-and-singular-agreement).

### Known-State 404 Recovery

An error message is a factual claim. State the smallest fact the product has
verified, then offer only a recovery action whose destination is also verified.
For a missing route, `This page doesn’t exist.` is enough. Do not guess that it
was moved, that the user lacks access, or why it is missing. Those guesses make
a product claim and can send the user to the wrong recovery path.

| State                                          | Copy and action                                                                            | Never infer                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Child page missing; parent scope is accessible | `This page doesn’t exist.` + `Return to Team`                                              | That the page moved or which child was expected            |
| Parent scope still resolving                   | Keep the literal message and reserve the action area; show no competing account action yet | That the parent is unavailable or another user is required |
| Parent scope unavailable or inaccessible       | Do not offer a parent return. Use the available account/auth recovery instead              | That an inaccessible team is safe to enter                 |

| ✅                                                                                     | ❌                                                                               |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `This page doesn’t exist.` + `Return to Team` when the team is resolved and accessible | `This page was moved. Go to Vercel Labs.`                                        |
| No action while the team is resolving                                                  | Briefly show `Log In as a Different User`, then replace it with `Return to Team` |

**Scope:** route-level not-found states with a potentially reachable parent.
**Exceptions:** validation, permission denials, known server-side redirects,
and 5xx failures use their own state-specific patterns. A known redirect should
redirect; it should not narrate a hypothetical move on a 404.

**Review:** verify the child-missing, parent-pending, parent-inaccessible, and
logged-out states. The action is correct only when its destination is safe in
the rendered state.

**Rules:** rule/known-state-error, rule/actionable

### Upstream / Partner Errors

When an upstream service returns an error that surfaces in the UI, **never show the raw error object verbatim**. The treatment depends on which kind of upstream:

- **Marketplace partner integrations** (Neon Postgres, Auth0, Linear, Upstash, Vercel Postgres marketplace partners, etc.): surface actionable partner messages **verbatim with attribution** — e.g. `Neon Postgres: This database has been suspended for review.` Users debugging a partner-side issue need the partner’s exact wording to grep partner support docs and forums; rewriting the message to Vercel voice strips that signal.
- **Other upstream providers** (Stripe, GitHub OAuth, the model provider for AI Gateway, etc.): translate to short Vercel-voice copy with the appropriate stable ID per the recipe below.

Recipe (non-Marketplace upstream):

1. **Extract the upstream code or short reason** (`card_declined`, `rate_limit_exceeded`, `repository_not_found`).
2. **Map to a one-sentence Vercel-voice message.** What happened, in user-language. Use the [Couldn’t vs Failed to](#error-messages) decision: user-action (declined card) → `Couldn’t`; system-side (provider down) → `Failed to`.
3. **Append the stable ID on a sub-line** — the Vercel request ID for AI Gateway, the integration `cfg_…` for Marketplace context, etc. Match the prefix to the label per [Stable Identifiers](#stable-identifiers). Don’t invent ID labels that aren’t in that table.
4. **Optional `Provider error: <code>` sub-line** when the upstream code is short and useful for triage. Skip it when the upstream message is opaque or marketing.

Example (non-Marketplace upstream — billing, OAuth, AI Gateway):

```
Couldn’t process payment — your card was declined. Try a different payment method.
Provider error: card_declined
Request ID: dyn_2k7Hb9
```

Anti-pattern (never ship — raw error object):

```
{ "error": { "type": "StripeCardError", "code": "card_declined", "decline_code": "insufficient_funds", "message": "Your card was declined." } }
```

## Stable Identifiers

Engineers triage by pasting into Slack/GitHub/issue trackers. Pair **platform/system errors** with a copyable stable ID so they’re greppable across logs.

> ✅ **Always pair stable IDs with:** API failures, build/deploy errors, runtime errors, integration auth failures, incident surfaces, AI Gateway request errors, partner platform errors.
>
> 🚫 **Never pair stable IDs with:** form validation, permission denials, "you typed the wrong code", "domain already in use", role-based access denial, plan-tier denial. These are user-state errors; there is no platform-side ID to surface and pasting one would be noise.

Scope: this rule applies to errors that flow from Vercel platform state — API failures, build/deploy errors, runtime errors, integration auth failures, incident surfaces. **It does not apply to user-state errors** (form validation, permission denials, “you typed the wrong code,” “domain already in use”). Those have no platform-side ID to surface; pasting one would be noise. The rule of thumb: if the error has a corresponding entry in Datadog or audit logs, attach the ID; if it’s purely a UI-state mismatch, don’t.

The IDs to surface, by error type. **Match the prefix to the label** — never show `Request ID: dpl_…` (that’s a Deployment ID, not a Request ID).

| Error type                        | Label                           | Prefix                    | Source                            |
| --------------------------------- | ------------------------------- | ------------------------- | --------------------------------- |
| Platform error (any UI surface)   | `Request ID`                    | (no prefix; opaque token) | `x-vercel-id` response header     |
| Build / deploy error              | `Deployment ID`                 | `dpl_…`                   | Deployment object                 |
| Build-step error                  | `Build ID`                      | `bld_…`                   | Build object                      |
| Workflow / cron failure           | `Run ID` (or `Workflow Run ID`) | (opaque)                  | Workflow runtime                  |
| AI Gateway request error          | `Request ID`                    | (opaque)                  | Gateway response                  |
| AI Gateway model output           | `Generation ID`                 | (opaque)                  | Gateway response (per generation) |
| Auth / API Key context            | `Key ID`                        | `key_…`                   | Key object                        |
| Marketplace / partner integration | `Integration ID`                | `cfg_…`                   | Integration config                |
| Observability / log handoff       | `Trace ID`                      | (opaque)                  | OTEL trace                        |

Surface convention:

- Place in monospace sub-line below the human message, OR behind a copy button.
- Never replace the human message with only an ID.
- Always copyable (one-tap copy on mobile, click-to-copy on web).

Example (build/deploy error — prefix `dpl_…`, label `Deployment ID`):

```
Build failed. Bundle exceeds 50 MB.
Deployment ID: dpl_x7hB2kLm9qR3
```

Example (platform error from any other surface — opaque request token, label `Request ID`):

```
Couldn’t load deployments. Try again.
Request ID: dyn_2k7Hb9
```

Apply on: error pages (`error.tsx`), platform-error toasts, error notes, modal errors that surface platform state, empty-state error variant, audit-log entries. Don’t apply to: validation messages (`Domain must be a valid hostname.`), permission denials (`Only team owners can change billing settings.`), or user-state mismatches (`That code is invalid. Try again.`).

## Incident & Status-Page Copy

When the Vercel platform is degraded, status copy surfaces to users. Incident copy is one of the few places `please` and `we’re sorry` are allowed (app at fault).

Surface choice by blast radius, not by tone.

| Blast radius                                                                    | Surface                                      | Persistence    | CTA required?     |
| ------------------------------------------------------------------------------- | -------------------------------------------- | -------------- | ----------------- |
| System-wide (affects whole dashboard or unrelated features)                     | `<Banner>` (page-level)                      | Until resolved | Yes (status link) |
| Single-region degradation that breaks auth/billing/deploy globally              | `<Banner>` (page-level)                      | Until resolved | Yes               |
| Per-feature or per-resource (single page scope)                                 | `<Note>` (inline)                            | While relevant | Optional          |
| Affected feature renders independently and its own UI is the most legible place | In-component fallback (table row, card body) | While relevant | Per-component     |

A degradation in a single region’s deployments belongs in a `<Note>` on the deployments view, not a global banner — unless that region’s degradation breaks auth or billing for everyone.

Severity ladder (used by both surfaces):

| State                       | Visual                              | Tone                                 |
| --------------------------- | ----------------------------------- | ------------------------------------ |
| Investigating / Identified  | `type="warning"`                    | Neutral, factual                     |
| Degraded performance        | `type="warning"`                    | Acknowledge impact, name the surface |
| Major outage / Service down | `type="error"`                      | Direct, named scope, ETA if known    |
| Maintenance                 | `type="secondary"`                  | Schedule + duration + scope          |
| Resolved                    | `type="success"` (24h) then dismiss | Brief acknowledgement                |

Scope phrasing. Name the affected surface and region:

- ✅ `Deployments in iad1 (US East) are degraded.`
- ✅ `Image optimization is currently unavailable.`
- ❌ `Some services may be experiencing issues.`

Status-page link convention. Every incident surface links to `https://www.vercel-status.com`:

```tsx
// Per-feature: inline Note on the affected page
<Note type="warning" label="Incident" fill>
  Deployments in <b>iad1 (US East)</b> are degraded. Builds may queue or fail.{' '}
  <Link href="https://www.vercel-status.com">Follow the incident on Vercel Status.</Link>
</Note>

// System-wide: page-level Banner at the top of the dashboard layout
<Banner
  prefix={<IconWarning size={16} />}
  button={{ href: 'https://www.vercel-status.com', content: 'View Status' }}
>
  Vercel is investigating elevated error rates across all regions. Some deployments may queue or fail.
</Banner>
```

> In this repository, icons come from `lucide-react` (for example `AlertTriangle`).

**Scheduled / planned maintenance.** Future-state, not in-progress. Copy names the absolute UTC start time + duration + affected functionality; relative time goes in the tooltip.

Template:

```
Scheduled maintenance on {service} starts {Apr 28 at 14:00 UTC} and lasts about {2 hours}. {Affected functionality} will be unavailable.
```

```tsx
<Banner
  prefix={<IconClock size={16} />}
  button={{ href: 'https://www.vercel-status.com', content: 'View Status' }}
>
  Scheduled maintenance on Vercel Postgres starts Apr 28 at 14:00 UTC and lasts
  about 2 hours. Database queries will return errors during this window.
</Banner>
```

Use absolute UTC for the canonical start time (engineers triage by timezone); the human-friendly tooltip can relative-format. Don’t pre-warn more than 7 days out without a CTA (`Subscribe to updates`); banners that long-tail without action read as noise.

`please` is allowed in incident copy when:

- Asking the user to check the status page (they’re being inconvenienced).
- Asking the user to retry after our fault.

Don’t use `please` in incident copy when:

- The fix is automatic and no user action is needed.

## Async Operation States

Vercel’s highest-traffic surface. Get the vocabulary right.

- **State labels match canonical API/CLI enums.** Use `Ready`, `Building`, `Queued`, `Canceled`, `Error` verbatim, matching `lib/get-favicon.ts`. Don’t reword into verb phrases (`Deploying successfully` ❌).
- **Loading / progress copy:** ellipsis character (not three periods), present participle, no subject.

```tsx
{isLoading ? 'Verifying…' : 'Verified'}
{submitting ? 'Deploying…' : 'Deploy Project'}
<Spinner /> <span>Redirecting…</span>
```

| ✅             | ❌                               |
| -------------- | -------------------------------- |
| `Deploying…`   | `Your project is being deployed` |
| `Verifying…`   | `Verifying` (no indicator)       |
| `Redirecting…` | `Redirecting...` (three dots)    |

A bare present-tense verb without an indicator (`Verifying`) reads as a label, not a process. Always add `…` when the action is ongoing.

- **Keep users oriented during background work.** If removing a verbose thinking/working transcript creates dead air, replace it with a compact state cue (`Working…`, `Reviewing files…`, `Changes ready`) near the control or panel that triggered the work.
- **Keep stale-but-valid data during refresh.** Don’t replace a populated table/list with an empty loading state just because a search or filter refresh is running. Keep the previous results visible, dim or mark the region busy, then swap when fresh results arrive.
- **Don’t show determinate progress before progress can begin.** A 0% upload bar before file transfer starts reads as stuck. Use disabled/preparing copy (`Preparing upload…`) until bytes are moving; switch to `<Progress>` only when a percent is knowable.

- **Unknown-ETA phrasing:** give a specific maximum or name the external system the wait depends on.
  - ✅ `Still verifying — this can take up to 48 hours.`
  - ✅ `Waiting on DNS propagation.`
  - ❌ `This might take a while.`
- **Failure with recovery vs terminal failure** — distinguish in copy:

  | State                           | Copy template                                                        | Stable ID? |
  | ------------------------------- | -------------------------------------------------------------------- | ---------- |
  | Failed but auto-recovering      | `{Operation} failed. Re-{verb}ing from {last good state}…`           | No (yet)   |
  | Terminal — auto-retry exhausted | `{Operation} failed after {N} retries. {error code}.` + manual Retry | Yes        |
  | Terminal — no retry             | `{Operation} failed. {error code}.` + manual Retry button            | Yes        |

- **Auto-retry vs manual retry** — label the mechanic:

  | Mechanic                 | Copy                      | Button  |
  | ------------------------ | ------------------------- | ------- |
  | Auto-retry (in progress) | `Retrying automatically…` | None    |
  | Manual retry             | terminal error message    | `Retry` |

### Retry & Scheduled States

Distinguish in-progress retry from scheduled retry:

- **Retrying now (in progress):** `Retrying automatically…` (with ellipsis, ongoing). No button.
- **Retry scheduled (future):** `Retry in 5m` (countdown) or `Next attempt at 14:23 UTC` (timestamp). Tooltip on hover for the alternate format.
- **Manual retry available:** terminal error message + `Retry` button. No automatic retry.
- **Auto-retry exhausted:** `Failed after {N} retries.` + manual `Retry` button + stable ID.

Badge state for compound retrying. Extend canonical state vocabulary with:

- `Retrying` (amber): auto-retry in progress
- `Failing` (amber): repeated failures, may auto-recover
- `Failed` (red): terminal, no auto-retry pending

Time-format conventions:

- Tight tables: `5m`, `2h` (see [mechanics.md → Dates and Times](mechanics.md#dates-and-times))
- Prose: `5 minutes`, `2 hours`
- Specific timestamp in tooltip: `2026-04-27T14:23:00Z`

## Stalled But Not Failed

Operations that exceed their expected window without erroring need a third copy state. `In progress…` implies the original ETA still holds; `Failed.` implies recovery is needed when none is. Use this when the operation is still active but past its stated max.

Template: `Still {verb}ing. Usually completes within {expected duration}. {Recovery hint or check link}.`

| Surface                          | ✅                                                                                                           | ❌                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| DNS verification > 24 hours      | `Still verifying. Most domains finish within 24 hours. <Link>Check DNS records</Link>.`                      | `Verifying…` (no acknowledgement of the long wait) |
| Marketplace provisioning > 5 min | `Still provisioning. Most databases are ready within 2 minutes. Contact {Partner} support if this persists.` | `Provisioning failed.` (it hasn’t failed)          |
| Deployment build > stated max    | `Build is taking longer than usual. Most builds finish within 5 minutes.`                                    | (silence — leaves the user wondering)              |

Pair with a check link or escalation route when the user has agency. Don’t pair with a stable ID (the operation hasn’t errored, so there’s nothing to triage yet).

When the operation eventually does fail, transition to the terminal-failure copy with the stable ID per [Stable Identifiers](#stable-identifiers). Add the ID at the transition boundary — stalled copy has no ID; the failure does.

## Destructive Copy Patterns

For the severity ladder (reversible / irreversible-no-delete / with-downstream-effects) and per-modal shapes, see [surfaces.md → Destructive Actions](surfaces-modals.md#destructive-actions).

Voice rules that apply across all destructive copy:

- **Button uses `Verb + Noun`.** Not `Confirm`, not `OK`, not bare verbs (`Delete`, `Revoke`). Match the modal title’s verb: `Delete my-project`, `Revoke Token`, `Rotate Key`, `Remove Member`.
- **Name irreversibility precisely.**
  - When the action itself is irreversible (delete, rotate, revoke): close the body with the canonical phrase `This cannot be undone.`
  - When the headline action is reversible but the cascade isn’t (e.g. `Remove Team Member` is re-addable, but their revoked tokens can’t be recovered): close with `Some effects cannot be undone.` Don’t falsely claim the whole action is irreversible; users notice and trust degrades.
  - When the action is fully reversible (disconnect, leave team): omit the irreversibility line entirely. The cascade list (if any) is enough.
- **State the consequence with the resource name interpolated.** `my-project and all its deployments will be permanently deleted.`
- **Enumerate downstream effects** as a bullet list when more than one thing happens. Don’t bury them in prose.
- **High-stakes deletes require typed confirmation.** `type "delete my-project" to confirm`. The same gate applies to non-delete high-stakes actions: `type "rotate prod-token" to confirm`, `type "downgrade acme-team" to confirm`. Match the gate string to the verb on the destructive button.

## Toast Surface Selection

Toasts are transient, wrong for critical, persistent, or blocking state. Pick by persistence and severity:

| Surface         | Use for                                                        |
| --------------- | -------------------------------------------------------------- |
| Toast           | Non-blocking success, brief acknowledgment, non-critical info  |
| Inline error    | Field-level validation                                         |
| Note / Banner   | Persistent configuration warnings, feature availability        |
| Section message | Bulk operation results, partial failures                       |
| Modal           | Destructive confirmations, data-loss warnings, blocking errors |

Don’t use toasts alone for: billing failures, permission denials, data loss, or deploy failures engineers need to triage. Build/deploy failures **do** get a brief toast, but only as the trigger half of the [Hybrid: Toast + Persistent Surface](#hybrid-toast--persistent-surface) pattern — the toast is a flag; the row carries the recovery step and ID.

### Toast Event Semantics

The `useToasts()` API exposes `success`, `error`, `warning`, `message`. Don’t pick by what the call site reports. Pick by how the user experiences the event.

| Event from user’s perspective                                    | Method           | Example                                                |
| ---------------------------------------------------------------- | ---------------- | ------------------------------------------------------ |
| Action succeeded as intended                                     | `toasts.success` | `toasts.success('Domain added')`                       |
| User-initiated cancellation, neutral acknowledgment              | `toasts.message` | `toasts.message('Deployment canceled')`                |
| Action partially completed or has caveats the user should notice | `toasts.warning` | `toasts.warning('Deployed, but health checks failed')` |
| Action failed and the user must act or know                      | `toasts.error`   | `toasts.error('Couldn’t save settings. Try again.')`   |

A user-canceled deployment is **not** a success: the user didn’t want it deployed. Use `message`, not `success`. A partial-success deploy with skipped routes is **not** a success: use `warning`. The method maps to the user’s emotional read, not whether the function returned `200`.

For the toast component API and copy rules, see [surfaces.md → Toasts](surfaces-feedback.md#toasts).

### Hybrid: Toast + Persistent Surface

When state changes are both event-worthy AND need persistent triage (deploy failure, async-job completion):

- Brief toast (≤6 words) acknowledges the state change. No recovery step.
- Persistent surface (row, detail panel, error page) carries the full message + stable ID + recovery steps.

Example:

- Toast: `Build failed`
- Row: `Build failed — bundle exceeds 50 MB. Reduce or raise limit.` + `Deployment ID: dpl_x7hB2k`

Don’t repeat the recovery step in the toast; it disappears before the user can act on it.

## Permission & Access Copy

Three-part formula: **what they can’t do + why + how to fix it.** A denial without a route is a dead end.

Routing patterns by cause:

- **Role-based denial (team-internal):** route to the role-holder. `Only team owners can change billing settings. Ask a team owner.`
- **Plan-based denial:** route to upgrade. `Upgrade to Pro to enable On-Demand Concurrent Builds.` Use `Contact Sales` for Enterprise-only.
- **Configuration-based denial:** route to docs or the configuration surface. `This project requires SSO. Configure SSO in team settings.`

### Team-Internal Permission Denials

**Rule:** `rule/permission-unblock-path`.

For a **resolved** team-internal denial, name the unblock path when the
permission check can support it:

1. the blocked action and its object;
2. the user’s current effective access, when known;
3. the server-recommended minimum access, **only** when the exact ACL check
   returns it; and
4. the real resolver: an access-request flow, or the relevant team-owner
   destination.

`/v1/user/permissions/required-access` returns the accepted grants for an
exact action/resource check and may return a display-ready `recommended`
team role. Use that `recommended` value for “minimum role” copy. Do not
derive a lowest role from the role hierarchy, choose one from
`teamRoles`/`projectRoles`/`teamPermissions`, or claim that a team role
will unblock a project-scoped or policy-gated action.

Good, when the exact values are available:

> As a Viewer on Acme, you can’t edit `example.com`. A Developer role is
> required. [Ask a Team Owner to Update Your Access]

Good, when a resolver exists but no safe single recommendation exists:

> You can’t edit `example.com` with your current access. [View Team Members]

Bad:

> Additional permissions required.

> Only team Owners can edit `example.com`.

The first leaves the user to discover the action, reason, and resolver. The
second may ask for more privilege than necessary or be wrong for
project-level access. If current access, a recommendation, or a destination is
unknown, omit that field rather than guessing; still name the blocked action
and route to the closest truthful resolver. Do not apply this pattern to
cross-tenant, plan, external-provider, or organization-policy denials; use
their own resolver instead.

**Surface and interaction.** Keep the explanation adjacent to the unavailable
control or in the denial surface. A hover-only tooltip is insufficient: the
same information and resolver must work by keyboard and touch. Preserve
read-only context where safe. Do not add a lock icon, role list, or disabled
state merely to satisfy this pattern.

**Verification contract.** For each changed denial, prove the action/resource
and the access result come from the same ACL check; exercise the recommended
and no-recommendation responses; verify the resolver destination, keyboard
focus, touch activation, and a compact layout. This is a judgment rule, not a
copy-eval checklist item: role ordering and valid resolvers are product facts.

**Agent permission prompts.** Agent approval copy is not a raw permission dump. Group by user-facing capability and consequence:

- Name what the agent will do, the resource it can affect, and the risk. `Allow Agent to update project settings?` beats `Granted 24 permissions`.
- Separate read-only context from write actions. Read-only context can be described as access; write, billing, deploy, delete, or external-account changes need explicit approval.
- Avoid implementation-heavy API/scope names unless they help the user decide. Put technical scope details behind disclosure.
- Match the action verb to the decision. Use `Approve Plan` / `Approve Changes` for agent execution approval. Use `Allow Access` for OAuth-style third-party grants. Don’t use `Authorize` as a generic approval label.
- Severity follows consequence, not feature optimism. Destructive, billing, credential, or broad-account changes need warning/error treatment; neutral plan summaries should not hide high-risk actions.

For component-level patterns (badges, empty states, table rows showing access state), see [surfaces.md → Permission & access states](surfaces-errors.md#permission--access-states).

### Cross-Tenant Denials

When the user has zero ability to act (e.g., domain is owned by another team):

- Don’t suggest “contact your owner”. Wrong owner.
- Name the constraint and route to legitimate alternatives.

Example:

- ✅ `example.com is registered to another team. Use a different domain or transfer it.`
- ❌ `You don’t have permission to add example.com.`

The error string names the alternatives; the surface provides the routes. Render the alternatives as actionable chrome: a `Use Different Domain` text link inline, or a `Transfer Domain` button next to the input. Don’t leave the user to figure out where to click.

External-resolver denials route to the partner / external system:

- ✅ `GitHub revoked the integration. Reconnect on the GitHub settings page.`

### Third-Party Integration Auth Failures

GitHub / GitLab / Bitbucket / Linear / Slack auth-fail copy distinguishes by cause:

- **Token expired:** `Your GitHub connection expired.` → `Reconnect GitHub` CTA
- **Permission revoked:** `GitHub uninstalled the Vercel app.` → `Reinstall on GitHub` (link to provider)
- **Resource gone:** `The repository was deleted on GitHub.` → `Connect a different repo` CTA

Always name the provider explicitly. Generic “third-party” is confusing.
