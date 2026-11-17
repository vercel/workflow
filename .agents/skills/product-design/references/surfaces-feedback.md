# Surfaces — Feedback

Toast, Note, Banner, Tooltip, Empty State, and Loading copy. Inline feedback surfaces and the rules for choosing between them.

> **Editing this surface?** Start at [`SKILL.md` → Workflow](../SKILL.md#workflow), then load the matching entry in [`surfaces.md`](surfaces.md).

## Contents

- [Toasts](#toasts)
- [Empty States](#empty-states)
- [`<Note>`](#note)
- [`<Banner>`](#banner)
- [`<Tooltip>`](#tooltip)
- [Loading (Skeleton, Spinner, LoadingDots, Progress)](#loading-skeleton-spinner-loadingdots-progress)
  - [Loading Boundary](#loading-boundary)
  - [Transition Budget](#transition-budget)
  - [Skeleton Fidelity](#skeleton-fidelity)
  - [Reveal Groups](#reveal-groups)
  - [Permission-Dependent Controls](#permission-dependent-controls)
  - [Loading Copy](#loading-copy)

---

## Toasts

`toasts.success|error|warning|message`: first arg is user-facing copy. One sentence. Sentence case. No period if single sentence. **Never `successfully`** (the action name implies success). Completion toasts are `{Noun} {past-participle}`. Error toasts with a recovery step get two sentences (two periods).

When to use toast vs. inline / modal / banner: see [patterns.md → Toast surface selection](patterns.md#toast-surface-selection).

```ts
toasts.success('Blob deleted');
toasts.error('Couldn’t update environment variable. Try again.');
toasts.warning('This domain’s SSL certificate expires in 3 days');
toasts.message('Changes will take effect on next deployment');
```

| ✅                                   | ❌                                         |
| ------------------------------------ | ------------------------------------------ |
| `Blob deleted`                       | `Deleted Blob successfully`                |
| `Domain added`                       | `Domain added successfully`                |
| `Environment variable saved`         | `Your environment variable has been saved` |
| `Couldn’t verify domain. Try again.` | `An error occurred. Please try again.`     |

### Toast Pattern by Action

Pick the toast template by the **verb of the action that fired it**. Pattern is `{Subject} {past-tense state}`, no period, no `successfully`, no `has been`, no possessives like `Your team’s X has been updated.`

| Action verb       | Toast pattern                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save              | `{Setting} updated` · `{Setting} saved`. (`Default redirect URL updated` · `Environment variable saved`.)                                                                    |
| Toggle (boolean)  | `{Setting} enabled` / `{Setting} disabled`. (`Two-factor enforcement enabled` · `Verified Commits enforcement disabled`.)                                                    |
| Configure (first) | `{Subject} configured`. (`Directory Sync configured` · `SAML Single Sign-On configured`.)                                                                                    |
| Remove            | `{Subject} removed` · `{Subject} configuration removed`. (`Git scope removed` · `SAML configuration removed`.)                                                               |
| Bulk action       | `{Subject} {past-tense state}`. (`Tokens revoked` · `3 deployments deleted`.) Quantify when the action affected a known count.                                               |
| Async kicked-off  | `{Verb}ing {subject}…` (with ellipsis char). (`Applying policy to all projects…` · `Building deployment…`.) Use when the action returns immediately and continues in the bg. |

**Toasts must name what changed, not the parent feature.** If the API request body only mutated `feature.subfield`, the toast says `{Subject = subfield} {state}`, not `{feature} updated`. A toast that fires from `PATCH /teams/:id { saml: { enforced: false } }` is `SAML enforcement disabled`, not `SAML updated`.

Diagnostic: trace from the toast string back to the request body. If the toast names a parent and the body holds a single subfield, the toast is lying. Pair the action verb to the toast verb 1:1 (per [`verbs.md` → Destructive Verbs](verbs.md#destructive-verbs)) so the user reads the same word they clicked.

**Undo snackbar.** When a destructive action is reversible for a short window (delete-with-undo on archive, remove-from-list, hide-row), pair the past-tense toast with an `Undo` action button. Match the toast verb 1:1 to the destructive verb (per [`verbs.md` → Destructive Verbs](verbs.md#destructive-verbs)). Auto-dismiss after the undo window expires (5–10s).

```ts
toasts.message('Project archived', {
  action: { label: 'Undo', onClick: unarchive },
});
toasts.message('Member removed', {
  action: { label: 'Undo', onClick: readd },
});
```

`Undo` is the canonical action label — never `Restore`, `Bring back`, or `Cancel`. Use the snackbar pattern only when the rollback is genuinely safe; an `Undo` that re-creates state inconsistencies is worse than a confirmation modal.

## Empty States

Guide toward the next action; never a dead end. Pick by what the user needs.

### Empty-State Taxonomy (Priority Order)

1. **No-results.** Filter/search returned nothing. Most common. CTA optional.
2. **Onboarding (Blank Slate / Informational).** User hasn’t created the resource yet. Always include a CTA.
3. **Cleared/completed.** Work done; nothing pending. CTA optional.
4. **Permission/configuration.** User can’t see the data because of role/plan/config. CTA = how to gain access.
5. **Error.** Load failed. CTA = `Try Again` + copyable request ID.

**Nothing critical goes in an empty state.** They vanish when the list populates. Persistent warnings belong in `<Note>` or page header.

### 1. No-Results (Most Common)

Title Title Case. Description sentence case, quotes the query verbatim with curly quotes. CTA optional but `Clear Filter` is almost always right.

```tsx
<EmptyState.Root
  title="No Logs Match Your Filter"
  description={`No logs match “${query}”. Clear the filter to see all logs.`}
>
  <Button variant="secondary" onClick={clearFilter}>
    Clear Filter
  </Button>
</EmptyState.Root>
```

**Multi-facet filters.** When the filter is structured (severity + path + time range + status code) rather than a single typed query, don’t quote a single value. Title `No {Items} Match Your Filters` (plural). Description suggests widening or clearing. CTA `Clear All Filters` (or `Clear {Facet}` if one facet dominates the result):

```tsx
<EmptyState.Root
  title="No Logs Match Your Filters"
  description="Try widening the time range or clearing a filter to see more logs."
>
  <Button variant="secondary" onClick={clearAll}>
    Clear All Filters
  </Button>
</EmptyState.Root>
```

### 2. Onboarding (Blank Slate / Informational)

- **Blank Slate** (user knows the concept): title `No Deployments Yet` (Title Case for `EmptyState.title`), description `Push to your Git repository to create your first one.` No CTA when the next step happens elsewhere (Git push). Sentence-case alternative `No deployments yet.` is fine in inline copy (Note bodies, prose, audit logs); the EmptyState title slot is Title Case.
- **Informational** (first encounter): title is the surface name `Environment Variables`, description 1-2 sentences + docs link, primary CTA `Add Variable`.
- **Two parallel paths.** When the first action could legitimately be one of two things (Import vs Create, Repo vs Template), two CTAs are allowed: primary first, secondary second. Three or more CTAs is a smell.

```tsx
<EmptyState.Root
  title="No Projects Yet"
  description="Import a Git repository or deploy a template to create your first project."
  icon={<EmptyState.Icon icon={<IconFolder size={32} />} />}
>
  <Button>Import Repository</Button>
  <Button variant="secondary">Deploy Template</Button>
</EmptyState.Root>
```

### 3–6. Cleared, Permission, Tier-Gated, Error

| Variant                  | Copy template                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cleared/completed        | `No open incidents.` · `No deployments need review.` (neutral, not celebratory). No CTA.                                                                                                                                                                                                                                                     |
| Permission/configuration | `Only team owners can view audit logs. Ask a team owner for access.` No CTA when the resolver isn’t the current user.                                                                                                                                                                                                                        |
| Error                    | `Couldn’t load deployments. Try again.` + copyable request ID + `Try Again` button                                                                                                                                                                                                                                                           |

**Surface choice for permission/tier denials.** A user landing on a page they can’t view renders the Permission/configuration empty state full-page — not a Note, not a redirect, not a toast. Use a Note only when one tile inside an otherwise-accessible page is gated.

### Educational and Guide Variants

Opt-in patterns when concept needs teaching or sample data accelerates activation. Same `<EmptyState.Root>` shape; titles are outcome-framed.

- **Educational:** title `Ship Your First Deployment in 2 Minutes` + `Start Tour` + `Skip` (never auto-launch).
- **Guide:** title `Try Vercel With a Next.js Starter` + `Deploy Starter` + `Connect Repo` (sample-status escape).

### Anti-Patterns

- Dead-end description: `No deployments.`
- Vague CTA: `Continue` / `OK` / `Get Started`
- Humor that hides meaning · shaming tone · description repeating title
- Auto-launching a tour · tour CTA with no skip

### Accessibility

- `EmptyState` title is rendered as a `<div>`. Wrap content in a section landmark or its own `<h2>`/`<h3>` for screen-reader navigation if needed.
- Decorative icons: `aria-hidden="true"`. Informative icons: provide `alt` / `aria-label`.
- After an async filter change, wrap the region in `aria-live="polite"`.
- CTA must be a real `<Button>` or `<Link>`, not an `onClick` div.

## `<Note>`

Inline callouts. Copy lives in `children`; `label` is the short prefix. Valid `type` values: `default | secondary | tertiary | error | warning | success | alert | violet | cyan | ghost | lite | rotate-ccw`. No `type="info"`: omit `type` (default renders an info icon) or use `type="secondary"`.

- `label`: short Title Case prefix naming the topic (`Region Change`, `Rate Limit`). 1-2 words (≤ 2 words). No empty hedges (`Heads Up`, `FYI`, `Note`).
- `children`: one sentence, active voice, concrete.

```tsx
<Note type="error">That code is invalid. Try again.</Note>
<Note type="warning" label="Region Change">Changing this region restarts all functions.</Note>
<Note type="secondary">Usage resets on the 1st of each month.</Note>
```

## `<Banner>`

Page-level / system-wide announcement. Always paired with a single CTA via the required `button` prop. Use for trial expirations, plan-wide changes, system status, security advisories.

**Banner vs. Note.** Banner = page-level/system-wide, top of layout, CTA required (`button` prop). Note = inline/contextual, next to the field, CTA optional. Banner: `Your trial expires in 3 days`. Note: `Region change restarts functions`.

**Dismissibility.** Geist `<Banner>` is non-dismissible by design. If the message is dismissible, it’s probably not banner-worthy; use a `<Note>` or move it into the empty state. If a banner persists across reloads, the underlying issue is unresolved; don’t add ad hoc dismiss state.

**Copy.** `children`: one sentence, sentence case, active voice. Names the impact. `button.content`: Title Case, `{Verb} {Noun}`. `mobileCopy` (optional): tighter sentence for narrow viewports.

```tsx
<Banner
  prefix={<IconClock size={16} />}
  button={{ href: '/billing/upgrade', content: 'Upgrade to Pro' }}
  mobileCopy="Trial expires in 3 days"
>
  Your Pro trial expires in 3 days. Upgrade to keep your usage limits.
</Banner>
```

Other valid copy: `3 access tokens haven’t been used in 90 days. Rotate or revoke unused tokens.` paired with `Review Tokens`. Banner has no `type` prop; communicate severity through the `prefix` icon and copy tone. When you need a colored callout, use `<Note type="error|warning|...">` instead.

## `<Tooltip>`

One sentence/fragment in the `text` prop. Explain **why**, not **what**. The label names the thing. Bad: `text="Rate limit"` (repeats label) · `text="Click to override"` (describes interaction).

**Don’t wrap a labelled `<Input>` in a Tooltip.** Geist `<Input>` with a string `label` already renders a `<label htmlFor>` wrapper; a Tooltip around it puts the trigger on the label, not the field, and the tooltip text effectively becomes a second invisible label for screen readers. Put the help on a sibling icon button instead.

```tsx
<Tooltip text="Limits requests per second to this endpoint">
  <Button shape="circle" svgOnly aria-label="Rate limit">
    <IconLightning size={16} />
  </Button>
</Tooltip>
<Tooltip text="Only visible to team owners"><Badge>Private</Badge></Tooltip>

// Help icon next to a field — NOT a Tooltip wrapping the labelled Input
<div className="flex items-center gap-2">
  <Input label="Build Command" id="build-command" />
  <Tooltip text="Overrides the value from your Git provider">
    <Button shape="circle" svgOnly aria-label="Build command help">
      <IconHelp size={16} />
    </Button>
  </Tooltip>
</div>
```

### Lifecycle Tooltip Checklist

Renamed from “Beta”. Applies to every lifecycle badge that requires a tooltip per [mechanics.md → Beta / Preview / Experimental Badges](mechanics.md#beta--preview--experimental-badges) — `Alpha`, `Experimental`, `Beta`, `Early Access`. (`Preview` tooltip is optional; `GA` has no badge.)

Name at minimum the limits that apply: API stability, SLA, support coverage, pricing stability, data retention. Template:

```
{Label}: {one-line meaning}. {Specific limit, e.g., "API may change before GA" or "pricing not finalized"}.
```

For paid Beta features (Beta lifecycle + paid tier), combine in one tooltip — don’t stack two badges:

```tsx
<Tooltip text="Beta: usable today, bugs expected, no SLA. Billed on the Pro plan at standard rates.">
  <Badge variant="amber-subtle">Beta</Badge>
</Tooltip>
```

## Loading (Skeleton, Spinner, LoadingDots, Progress)

Pick by what the user is waiting on, not by aesthetic.

| Component       | Use when                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `<Skeleton>`    | Initial content or controls have a known final footprint. The placeholder represents their structure.                     |
| `<Spinner>`     | A short, indeterminate process or action has no final content shape to represent. Submit buttons, inline refresh actions. |
| `<LoadingDots>` | A short, indeterminate process is embedded in copy (`Saving`).                                                            |
| `<Progress>`    | Determinate work has a trustworthy known percent (uploads, multi-step setup).                                             |

Loading states preserve orientation. Keep the user’s last trustworthy context visible when possible:

- During a search/filter refresh, keep stale-but-valid results in place and mark the region busy. Don’t swap to an empty state unless the fresh query returns empty.
- If a verbose working log is collapsed or removed, leave a compact cue near the affected surface: `Working…`, `Reviewing files…`, `Finished`.
- Show `<Progress>` only when progress is measurable. Before upload bytes move, use `Preparing upload…` with a spinner; a 0% bar before transfer starts reads as stuck.

### Loading Boundary

Every async region owns a loading boundary that reserves its final geometry. A blank first paint is a defect, not a neutral starting point: nothing holds the space, the page height jumps when data lands, and the user cannot tell a slow page from a broken one.

- Render on the server whatever the server already knows. Page chrome, section headings, fieldset titles and descriptions, static helper text, and footer actions belong in the first paint. Server-rendered structure is the cheapest fix available here, because content that is never a skeleton never has to swap.
- Give every streamed or client-fetched region a fallback that matches its final footprint. A region with no route-level `loading` file, no `<Suspense>` fallback, and no local skeleton renders blank.
- Do not paint page chrome over an empty content area while the first request resolves. “It fills in quickly on my machine” is not a boundary.
- Place the boundary at the region that actually depends on the data. A boundary too high blanks stable content; a boundary around every leaf produces popcorn (see [Transition Budget](#transition-budget)).

### Transition Budget

Treat every visual change between first paint and settled content as a cost the user pays in attention. Count the transitions a screen makes and design it to settle in as few as possible.

A transition is any of: blank → content, skeleton → content, a control moving from disabled to enabled, a toggle or selected value correcting itself once its stored value arrives, a list growing after it first rendered, or a section resolving after the sections around it have already settled.

- Prefer zero transitions. Server-render or prerender anything whose value does not depend on a client request.
- Where a transition is unavoidable, spend it on one accurate change: reserved geometry → final content.
- Do not manufacture transitions the data does not require. A control that will be interactive for nearly every user should not start disabled, and a toggle should not render a default and then flip (see [Reveal Groups](#reveal-groups) on render readiness).
- Group the transitions that remain. Independent regions resolving at independent times is popcorning; it costs more than one coherent reveal a moment later. Group by what the user reads as one unit — a fieldset, a table, a header and its actions — not by which request happens to resolve first.

Popcorn check: load the surface under throttling and count the moments the page changes. If a settings page settles in six steps where two would do, the fix is grouping and server rendering, not faster requests.

### Skeleton Fidelity

A skeleton is the temporary geometry of its final content, not a generic loading decoration. Match the final CSS footprint, shape/radius, alignment, density, and major row or control structure. Match the structural unit; when the final item count is data-dependent, use a plausible stable count such as the page size rather than presenting a guess as exact. When several loading boundaries can own the same region—for example server streaming, authentication, and data fetching—use one canonical skeleton so the page does not reshape between fallbacks.

Prefer composing the skeleton from the same layout shell as the final content, with skeletons at the leaves, over maintaining a hand-measured parallel mock that can drift. Match stable geometry, not guessed text pixels. A known 24px rounded favicon slot gets a 24px rounded skeleton; a spinner in that slot is the wrong semantic and visual placeholder. A structured list should not begin as unrelated generic bars and then switch to a second, more accurate skeleton.

#### Settings Fieldsets

A settings page is a stack of fieldset shells: title, description, control area, and a footer with helper text and a save action. Only the control area depends on the request. Render the real fieldset with its real copy and wrap the unknown slots in `<Skeleton>`, which auto-sizes to the children it wraps, so the loading height is the final height by construction.

```tsx
// BAD — parallel mock of the fieldset; heights drift from the real one
<div className="rounded-md border p-6">
  <Skeleton height={16} width={160} />
  <Skeleton height={40} width="100%" />
</div>

// GOOD — real shell, real copy, skeleton only where the value is unknown
<SettingsFieldset
  description="How many runs to show per page."
  saveDisabled={!canSave}
  title="Page Size"
>
  <Skeleton show={loading}>
    <Select value={pageSize}>{options}</Select>
  </Skeleton>
</SettingsFieldset>
```

The save action stays disabled until the form is dirty, so it never flips from disabled to enabled on load.

#### Lists of Unknown Length

When the final row count is not knowable before the response, do not present a guess as exact and do not let the list assemble row by row.

- Render a plausible stable count (the page size when one exists) and fade the last rows out, so the placeholder reads as “more below” rather than an exact count that turned out wrong.
- When the group can expand well past the fold — webhook events, member lists, ownership rules — reserve a bounded number of rows plus the same `Show more` control the final content uses. The section height then stays put when the rest arrive instead of pushing everything below it down.
- Per-row remote images (avatars, favicons, provider logos) resolve after their row. Reserve the slot at its final size so images fill in place without reflowing the row.

### Reveal Groups

Prevent staggered pop-in when elements form one task unit or an intermediate combination would be incomplete or misleading:

- Define the smallest coherent reveal group and one readiness predicate for it. For example, a scope selector, query field, and submit action used together should reveal together.
- Gate on render readiness, not only request completion. Required labels, selected values, icons, metadata, and option registration must be ready before revealing the group.
- Keep the reserved skeleton in place until the group is ready, then replace it once. Do not delay ready content to make loading feel substantial or return to the initial skeleton after trustworthy content is visible. If cached or fast loads flash the fallback, use a brief, evidence-tuned grace period before showing it and verify both fast and slow paths.
- Do not make the entire page wait for unrelated or optional data. Reveal independent useful regions progressively with stable reserved space. Bound slow optional dependencies with a fallback, timeout, or degraded state rather than starving the primary task.
- During same-query revalidation, preserve current content and mark the affected region busy instead of replaying the initial reveal. When the query identity or scope changes and prior content would be misleading, clear it to the matching skeleton.
- Reveal the group once its slowest required member is ready rather than releasing members as they arrive. Waiting one moment longer to remove three transitions is the better trade; see [Transition Budget](#transition-budget).
- Placeholder-only skeletons are decorative: hide them from assistive technology and expose at most one loading status for the region. Use `aria-busy="true"` on the updating region when appropriate, but do not rely on it alone to communicate loading.

```tsx
<Skeleton width={200} height={20} />
<Button loading={saving}>Save Changes</Button>
<span>Saving<LoadingDots size={4} /></span>
<Progress value={42} max={100} />
```

> `<LoadingDots size>` is a `number` (dot diameter in px), not a string. Default is sufficient for inline use; pass an explicit number when you need to match adjacent type size.

### Permission-Dependent Controls

Assume the user has permission until the data says otherwise. Permission, role, and plan checks resolve on the same timeline as the content, so a control rendered disabled while they resolve tells the majority of users — the ones who do have access — that they are missing permissions, then contradicts itself a moment later.

- Render permission-gated controls in their normal enabled state while the check is unresolved. Apply the disabled, hidden, or upgrade treatment once the answer is known. The happy path is the common path, and rendering it costs nothing when the user turns out to be allowed.
- Never use `disabled` as a loading affordance. Disabled means the user cannot do this; a skeleton or the component’s busy state means the system is not ready. A greyed-out search field, `Show more`, or primary action during load reads as a permissions problem, not as loading.
- Keep the optimistic path safe: if the action is reachable before its data settles, await the pending request or use the component’s `loading` state on activation rather than pre-emptively disabling. When acting on an unresolved value would delete data or spend money, gate on the value with the busy affordance instead.
- Once resolved, a denial still needs its reason and resolver. See [`resilience.md` → Permission and Policy States](resilience.md#permission-and-policy-states).

```tsx
// BAD — unresolved permission renders as a denial, then flips
<Button disabled={isLoading || !canManage}>Add Member</Button>
<SearchInput disabled={isLoading} />

// GOOD — happy path renders now; the gate applies once it is known
<Button disabled={canManage === false} onClick={addMember}>Add Member</Button>
<SearchInput onChange={setQuery} />
```

### Loading Copy

When no skeleton is possible, `Loading…` (Title Case word + ellipsis character `…`, not three periods) is the default. Never:

- `Please wait…` (banned filler).
- `Loading...` (three periods, not the ellipsis character).
- `One moment…` (vague).

For long operations (>3s), name the work: `Building deployment…`, `Uploading 12 files…`. Pair with progress when total is knowable.
