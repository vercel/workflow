# Surfaces — Error & Permission Pages

Route-level error pages, permission/access denials, OAuth consent screens.

> **Editing this surface?** Start at [`SKILL.md` → Workflow](../SKILL.md#workflow), then load the matching entry in [`surfaces.md`](surfaces.md).

## Permission & Access States

Tell the user what they can’t do, why, and how to fix it. For copy patterns and denial-routing rules across surfaces, see [patterns.md → Permission & access copy](patterns.md#permission--access-copy).

| ✅                                                                    | ❌                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------- |
| `You don’t have permission to delete this project. Ask a team owner.` | `Action not permitted.`                               |
| `Upgrade to Pro to enable On-Demand Concurrent Builds.`               | `This feature is not available on your current plan.` |
| `Only team owners can change billing settings.`                       | `Insufficient permissions.`                           |

A denial without a route (team owner, plan upgrade, docs page) is a dead end.

For a resolved team-internal denial with source-backed current and recommended
access, follow [patterns.md → Team-Internal Permission
Denials](patterns.md#team-internal-permission-denials) (`rule/permission-unblock-path`).
Name the blocked action and object, use the server-provided recommendation only
when present, and give a keyboard- and touch-reachable resolver. Do not infer a
lowest role from raw ACL alternatives.

For agent approval prompts, don’t mirror raw scopes or permission counts. Summarize capabilities by user-facing consequence, separate read-only context from write actions, and use `Approve` only when the user is approving an agent action. OAuth-style grants use `Allow Access`; see [OAuth Consent](#oauth-consent).

## Route-Level Error Pages (`error.tsx` / `not-found.tsx`)

Next.js App Router error boundaries (in `packages/web`, the React Router `ErrorBoundary` in `app/root.tsx` plays the same role). Both render full-page; both need a clear next step.

**`error.tsx`** (caught error boundary, 5xx): title `Couldn’t Load Page`, body `Try again, or check the Vercel status page.`, primary `Try Again` (calls `reset()`), secondary `Check Status` (<https://status.vercel.com/>), collapsed `<details>` with the request ID (`error.digest`).

> Don’t use `Something Went Wrong` here. It’s on the [Banned Phrases](copy.md#banned) fallback list precisely because it’s the LLM-default 5xx title and skips the chance to name what failed.

**`not-found.tsx`** (route 404): title `404`, body `This page doesn’t exist.`
When a resolved, accessible parent scope remains, make that exact parent the
primary action (`Return to Team`). While parent access resolves, reserve the
action area and suppress a competing account action. If the parent is missing
or inaccessible, do not offer it; use the available account/auth recovery.
Never imply a move, permission cause, or intended child resource unless the
server established it. See [patterns.md → Known-State 404
Recovery](patterns.md#known-state-404-recovery) (`rule/known-state-error`).
Technical details usually omitted.

**Required structure:** title + one sentence-case factual body + a safe next
step when one is resolved + (5xx only) collapsed technical details. A pending
parent scope may reserve the action area without showing an action.

```tsx
'use client';
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-heading-24">Couldn’t Load Page</h1>
      <p>Try again, or check the Vercel status page.</p>
      <Button onClick={reset}>Try Again</Button>
      <Button variant="secondary" href="https://status.vercel.com/">
        Check Status
      </Button>
      {error.digest ? (
        <details>
          <summary>Technical details</summary>Request ID:{' '}
          <code>{error.digest}</code>
        </details>
      ) : null}
    </div>
  );
}
```

Naming: **`Try Again`** (caught error, retry-safe) and **`Return to Team`**
(missing child inside a resolved team). Don’t use a generic 404 escape hatch
when a safer, remaining scope is known; `Reload` and `Home` are imprecise.

## OAuth Consent

For `app/(auth)/oauth/marketplace/authorize/prompt/`. Consent screens have one job: tell the user exactly what they’re authorizing.

**Scope-disclosure language:** `Allow {App} to read your projects?` Verb the scope grants (`read`, `manage`, `deploy to`), name the resource (`your projects`, `your team’s billing`).

Group scopes by capability and risk, not by API object. Prefer readable groups:

- `Read`: projects, deployments, team profile
- `Manage`: domains, environment variables, integrations
- `Billing`: invoices, payment methods, usage limits

Avoid broad catchalls like `All teams and projects` unless the grant truly spans every team the user can access. If it does, explain the scope and provide a selector: `All teams you can access` or `Selected teams and projects`.

**CTAs:**

- Primary: `Allow Access` (Title Case, `Verb + Noun`). Never `Continue`, `OK`, `Authorize`.
- Secondary: `Deny` for new grants. `Cancel` for re-auth or modifying an existing grant. The distinction matters: `Deny` records a refusal; `Cancel` backs out without a decision.

**What-happens-after-allow copy:** one sentence below the scope list explaining the grant’s effect. `{App} will be able to read your project list and deployment URLs until you revoke access from your account settings.`

**Session vs. persistent grant:** if the grant is session-only, say so explicitly: `Access expires when you close this tab.` Persistent grants get the revocation route: `Revoke anytime from {Account → Connected Apps}`.

```tsx
<h1 className="text-heading-24">Allow Acme to Access Your Account?</h1>
<p>Acme is requesting permission to:</p>
<ul>
  <li>Read your projects and deployments</li>
  <li>Read your team’s billing summary</li>
</ul>
<p>Acme will be able to read this data until you revoke access from Account → Connected Apps.</p>
<Button onClick={allow}>Allow Access</Button>
<Button variant="secondary" onClick={deny}>Deny</Button>
```
