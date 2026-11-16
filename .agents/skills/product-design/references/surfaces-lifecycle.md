# Surfaces — Lifecycle & Auth

Product lifecycle surfaces (Workflow runs, Sandbox, Queues), Notification Center, Auth (Sign Up & Log In).

> **Editing this surface?** Start at [`SKILL.md` → Workflow](../SKILL.md#workflow), then load the matching entry in [`surfaces.md`](surfaces.md).

## Contents

- [Notification Center & Activity Feed](#notification-center--activity-feed)
- [Workflow Runs](#workflow-runs)
- [Sandbox & Queues](#sandbox--queues)
- [Auth (Sign Up & Log In)](#auth-sign-up--log-in)

---

## Notification Center & Activity Feed

Inbox-style list of recent platform events (deploy completed, integration installed, member joined, comment received). Distinct from toasts (transient) and Banners (page-level). Each item is a past-tense audit-log-shaped row; the inbox is read-mostly.

- **Item title.** `{Actor} {past-tense-verb} {resource}` — same shape as audit-log entries (see [`mechanics.md` → Audit Log Event Language](mechanics.md#audit-log-event-language)). Sentence case. No period (it’s a fragment that names an event, not a sentence).
- **Item secondary line.** Optional. Sentence case, fragment, names the scope or impact (`In Production`, `2 minutes`, `dpl_x7hB2k`).
- **Relative time.** `<RelativeTimeCard>` on every item; absolute timestamp on hover.
- **Unread badge.** Numeric count via `<SidebarLink badgeCount={n}>`; drop the badge at zero.
- **Empty state.** Cleared variant: `No new activity.` (no CTA — the inbox fills itself).
- **Don’t toast and inbox the same event.** If it’s in the inbox, it’s not transient enough for a toast; if it’s in a toast, it’s too transient to land in the inbox. Pick one. The exception is the [Hybrid: Toast + Persistent Surface](patterns.md#hybrid-toast--persistent-surface) pattern for build/deploy failures, where the persistent surface is the deploy row, not the inbox.

```tsx
<NotificationItem unread>
  <span className="text-label-14">
    Jane Smith deployed dpl_x7hB2k to Production
  </span>
  <span className="text-copy-13 text-gray-900">
    <RelativeTimeCard date={ts} /> · my-app
  </span>
</NotificationItem>
```

For toast vs inbox routing, see [`patterns.md` → Toast Event Semantics](patterns.md#toast-event-semantics).

## Workflow Runs

Vercel Workflows (WDK) durable runs. Status badges and modal copy share vocabulary with [Canonical Status Terms](surfaces-buttons.md#canonical-status-terms).

| State             | Badge                                                   | Body copy template                                                                                                                                                      |
| ----------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Running`         | `<Badge variant="blue-subtle">Running</Badge>`          | `Started <RelativeTimeCard date={ts} />.`                                                                                                                               |
| `Awaiting Signal` | `<Badge variant="amber-subtle">Awaiting Signal</Badge>` | `Paused waiting for {signal-name}.` Pair with a named action button (`Resume Run` for human approval; the verb names the signal).                                       |
| `Sleeping`        | `<Badge variant="amber-subtle">Sleeping</Badge>`        | `Sleeping until <RelativeTimeCard date={wakeAt} />.` No action; durable timer fires automatically.                                                                      |
| `Compensating`    | `<Badge variant="amber-subtle">Compensating</Badge>`    | `Rolling back side effects from {step-name}.`                                                                                                                           |
| `Failed`          | `<Badge variant="red-subtle">Failed</Badge>`            | `Step {step-name} failed. <recovery>` + `Retry Run` or `Restart Run` button. Pair with run ID per [`patterns.md` → Stable Identifiers](patterns.md#stable-identifiers). |
| `Cancelled`       | `<Badge variant="gray-subtle">Cancelled</Badge>`        | `Cancelled by <RelativeTimeCard date={ts} />.` Note the spelling — Workflow’s `Cancelled` is the documented exception to Vercel’s `Canceled` rule; mirror the API enum. |

**Action button verbs for human-gated workflow runs:**

- `Approve and Resume` — when the gate is approval/rejection.
- `Resume Run` — generic resume after pause.
- `Restart Run` — start over from step 1, discarding partial state.
- `Retry Run` — retry from the failed step, preserving prior state.
- `Cancel Run` — terminate a Running or Sleeping run (irreversible, treat as destructive: `Verb + Noun` rule applies).

```tsx
<Note type="warning" label="Awaiting Signal">
  Run paused waiting for human approval. Reviewer requested by <b>{requestor}</b> at <RelativeTimeCard date={ts} />.
</Note>
<div className="flex gap-2">
  <Button onClick={approve}>Approve and Resume</Button>
  <Button variant="secondary" onClick={reject}>Reject Run</Button>
</div>
```

`Reject Run` follows Verb + Noun. Bare `Reject` is the bug to avoid.

## Sandbox & Queues

### Vercel Sandbox

Ephemeral microVM lifecycle. State labels match `<Badge>` states; copy mirrors deployment vocabulary where possible.

| State        | Badge                                            | Copy                                                                                                         |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `Running`    | `<Badge variant="blue-subtle">Running</Badge>`   | `Sandbox running. Expires <RelativeTimeCard date={expiresAt} />.`                                            |
| `Stopped`    | `<Badge variant="gray-subtle">Stopped</Badge>`   | `Stopped manually.` Pair with `Start Sandbox` button.                                                        |
| `Expired`    | `<Badge variant="amber-subtle">Expired</Badge>`  | `Expired after {duration}.` Pair with `Create Sandbox` button.                                               |
| `Terminated` | `<Badge variant="red-subtle">Terminated</Badge>` | `Terminated by Vercel — {reason}.` Reason is one of `policy violation`, `resource limit`, `unhandled crash`. |

Destructive verbs: `Stop Sandbox` (reversible — Verb + Noun per [Destructive Actions](surfaces-modals.md#destructive-actions)). `Terminate Sandbox` is admin-only and irreversible — use the Severity Ladder pattern. Both are listed in [`verbs.md` → Destructive Verbs](verbs.md#destructive-verbs); past-tense forms are `Sandbox stopped` and `Sandbox terminated`.

### Vercel Queues

Durable event-streaming. Per-message states are scoped to the queue dashboard.

| State         | Badge                                             | Copy                                                                                                            |
| ------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Pending`     | `<Badge variant="gray-subtle">Pending</Badge>`    | `Awaiting first delivery attempt.`                                                                              |
| `Processing`  | `<Badge variant="blue-subtle">Processing</Badge>` | `Delivery in progress…`                                                                                         |
| `Delivered`   | `<Badge variant="teal-subtle">Delivered</Badge>`  | `Delivered <RelativeTimeCard date={ts} />.`                                                                     |
| `Failed`      | `<Badge variant="amber-subtle">Failed</Badge>`    | `Delivery failed after {n} attempts. Next retry in {duration}.` Pair with the message ID.                       |
| `Dead-Letter` | `<Badge variant="red-subtle">Dead-Letter</Badge>` | `Moved to dead-letter queue after {n} failures. Inspect or replay manually.` Pair with `Replay Message` button. |

For dead-letter inspection modals, the canonical CTA is `Replay Message` (Verb + Noun, non-destructive).

## Auth (Sign Up & Log In)

Vercel auth surfaces use `Sign Up` and `Log In` as canonical button/heading labels. Body prose uses lowercase `sign up` / `log in`. Past-tense in toasts and audit logs is `Signed up` / `Logged in` / `Logged out`.

| Surface                      | Form                                                         | Notes                                                                                      |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Primary CTA on a signup page | `Sign Up` (Title Case button)                                | Title Case treats `Up` as significant. Don’t lowercase `up`.                               |
| Primary CTA on a login page  | `Log In` (Title Case button)                                 | Both words capitalized — Title Case treats `In` as significant in this short phrasal verb. |
| Secondary action             | `Log Out` (Title Case button)                                | Same shape as `Log In`.                                                                    |
| Body prose                   | `To sign up, …` / `After you log in, …`                      | Verb is two lowercase words.                                                               |
| Toast / audit log            | `Signed up`, `Logged in`, `Logged out`                       | Sentence case past tense.                                                                  |
| Inverse on the same page     | `Already have an account? Log In` / `New to Vercel? Sign Up` | Pair the two so a user landing on the wrong page can switch.                               |

Don’t mix `Sign In` and `Log In` in the same flow. Vercel’s primary auth pages standardize on `Sign Up` and `Log In`. Embedded OAuth flows from third parties (Slack, GitHub) keep the partner’s verb if the destination dictates it (`Sign in with GitHub`); the surrounding Vercel chrome stays on `Log In`.

```tsx
<h1 className="text-heading-32">Log In to Vercel</h1>
<Button typeName="submit">Log In</Button>
<p className="text-copy-14 text-gray-900">
  New to Vercel? <Link href="/signup">Sign Up</Link>
</p>
```
