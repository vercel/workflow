# Interface Resilience

Use this reference when real data, localization, network behavior, permissions, or boundary conditions can break the ideal interface. Apply only dimensions the product can encounter.

## Contents

- [Content pressure](#content-pressure)
- [Localization and direction](#localization-and-direction)
- [Async and network behavior](#async-and-network-behavior)
- [Data boundaries](#data-boundaries)
- [Permission and policy states](#permission-and-policy-states)
- [Verification matrix](#verification-matrix)

## Content Pressure

Test the layout with:

- the shortest valid value
- a long project/team/resource name
- long unbroken technical identifiers and URLs
- large numbers, dates, durations, and units
- one item, many items, and missing optional metadata
- user-generated emoji and non-Latin text where accepted
- browser zoom/text scaling at 200%

Use wrapping, truncation, disclosure, and scrolling deliberately:

- Truncate only when the full value remains available through an accessible detail, copy action, expansion, or destination.
- Preserve identifiers users must compare or paste; do not truncate away the distinguishing suffix by default.
- Set `min-width: 0`/equivalent on flex/grid children that must shrink.
- Avoid fixed-width text controls and action groups that assume English-length labels.
- Keep primary actions reachable when copy wraps.

## Localization and Direction

- Use repository localization primitives when the surface is localized; do not assemble translated sentences from fragments.
- Use locale-aware number, date, time, duration, plural, and currency formatting.
- Budget for text expansion through flexible layout rather than arbitrary extra whitespace.
- Prefer logical start/end properties and direction-aware icons when the interface supports RTL.
- Verify that code, identifiers, paths, and commands preserve their intended direction inside RTL content.
- Do not claim localization/RTL support if the product area does not currently provide it; report the risk and owning constraint.

## Async and Network Behavior

For each mutation, establish:

- pending behavior and duplicate-submission prevention
- whether cancellation is possible
- timeout behavior
- retry safety/idempotency
- optimistic update and rollback behavior
- stale response/race handling
- conflict behavior when another actor changes the same object
- what input/state survives failure

Keep the original action label while pending. Use the component’s loading/busy API and preserve focus. Do not show success before the system has reached the state the message claims.

When a failure remains relevant after a toast disappears, persist the error and recovery action in the affected region.

## Data Boundaries

- Empty is not the only boundary. Test one item, the pagination threshold, maximum selectable items, maximum field length, and high-cardinality lists.
- Use pagination or virtualization when supported by the product pattern; do not render an unbounded list because fixtures are small.
- Preserve stable sort/filter state across loading and refresh.
- Handle missing, partial, stale, and redacted fields without collapsing the layout or inventing values.
- Do not turn `0`, `false`, or an empty-but-valid string into “missing” through truthiness checks.

## Permission and Policy States

Distinguish:

- cannot view
- can view but not edit
- can edit some fields
- role-owner action required
- plan upgrade required
- organization policy blocks the action
- resource belongs to another team/account

Preserve useful read-only context when policy allows it. Disable controls only when users benefit from seeing unavailable capability and the reason is adjacent; otherwise hide actions the user cannot perform. Never leave a disabled control with no explanation or resolver.

These states apply once the check has resolved. While it is pending, assume the user has the permission and render the control as available; most users do, and a disabled control during loading reads as a denial. See [`surfaces-feedback.md` → Permission-Dependent Controls](surfaces-feedback.md#permission-dependent-controls).

### Settings Access Representation

For organization, team, and project settings, preserve the product map when permissions, plan, policy, or a disclosed product prerequisite prevents use. Keep permitted-to-know sections, fields, labels, and their order stable across access states. Do not hide, move, or replace settings merely because access resolves differently. Stable placement helps users understand which scope owns a setting, why it is unavailable, and what must change to gain access.

| Resolved state                         | Representation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can read and edit                      | Render the normal editable control.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Can read but not edit                  | Keep the current readable value in place and disable or make the control read-only. Put the reason and resolver next to the unavailable control.                                                                                                                                                                                                                                                                                                                                                                                               |
| Cannot read the value                  | Keep the field only when the user is allowed to know it exists. Use the shared `Redacted` treatment from `components/account/fieldsets/redacted.tsx` in the same position rather than creating a custom obscured placeholder, and do not fetch, serialize, or expose the restricted value to the client or DOM. Provide programmatically available restricted/unavailable text and a resolver when disclosing them is permitted; otherwise use a generic non-sensitive explanation. Hide decorative obscuring marks from assistive technology. |
| Cannot know the setting exists         | Omit the setting. Do not preserve layout by leaking restricted product or policy information.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Aggregate contains inaccessible detail | Keep the aggregate surface available using only accessible resources. Name inaccessible detail as hidden or unavailable; never present redaction as an empty result.                                                                                                                                                                                                                                                                                                                                                                           |

Use a semantic read-only presentation when editing is unavailable. A disabled control is appropriate when preserving the familiar setting representation helps the user understand the product; plain text is appropriate when a disabled control would imply that editing can be unlocked in place. In both cases, retain the readable value.

This access-state rule does not override progressive disclosure for configuration that has no effect while its parent setting is off. Continue to hide irrelevant dependent controls as defined in [`surfaces-forms.md` → Progressive Disclosure](surfaces-forms.md#progressive-disclosure-of-dependent-controls-ruleprogressive-disclosure). It applies when an otherwise relevant setting is unavailable because of access, policy, plan, or a product prerequisite the user is allowed to know about.

Rollout, experiment, and visibility flags are not disclosed prerequisites. Preserve their canonical route and navigation behavior, including `notFound()` for intentionally unreleased pages. Never expose a hidden feature to make its future layout stable.


### Accessible Aggregate Scope

Aggregate organization, team, and project settings remain useful when users can access only part of the resource graph. Calculate displayed results from the accessible resource set rather than hiding the page or implying organization-wide coverage. State the scope wherever omission could change interpretation. For example, an organization Usage page for a member with access to two of ten teams shows usage for those two teams and identifies the result as accessible-team usage.

Model two sets explicitly:

- The **readable set** drives lists, tables, charts, summaries, counts, legends, filters, search, exports, and downloadable data.
- The **action-eligible set** drives selection, “all” controls, confirmation copy, bulk mutation targets, and post-action results.

These sets should be equal unless the product intentionally allows a user to read resources they cannot change. When they differ, keep readable resources visible, disable their selection or editing, and name both scopes before commit. Do not label a control “All projects” when it means only action-eligible projects, or when it may target projects outside the visible set, without stating the exact target. After a partial bulk action, identify applied and skipped resources or provide a path to them; a generic failure count is not enough when users need to understand the resulting configuration.

Pagination and client-side filtering must not produce a false empty aggregate. If search covers only loaded accessible resources, say so and keep a path to continue loading or use server-side search.

| ❌ Ambiguous                                                                              | ✅ Scoped                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Usage total silently includes ten organization teams when the member can inspect only two | Usage total is calculated from the two readable teams and labelled `Accessible teams`                                        |
| `All projects` changes a hidden team-wide set while rows show only readable projects      | `All editable projects (8)` targets the action-eligible set; two additional read-only projects remain visible and unselected |
| A redacted grants array renders `No grants`                                               | The section remains in place and renders `Grants hidden` with a permitted resolver                                           |


## Verification Matrix

| Dimension         | Minimum evidence                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Long content      | Render a realistic long noun/identifier and wrapped explanatory text                                                                                               |
| Narrow width      | Verify the compact supported layout and any breakpoint boundary                                                                                                    |
| Short landscape   | Verify 951×589 and 594×368: the primary action is visible or intentionally below the fold; content scrolls instead of clipping                                     |
| Large data        | Exercise the relevant threshold or inspect the virtualization/pagination path                                                                                      |
| Validation        | Trigger each changed validation branch; confirm input preservation and focus                                                                                       |
| Network failure   | Exercise retryable and non-retryable outcomes supported by the API                                                                                                 |
| Permission        | Render the applicable role/plan/policy state from source-supported fixtures                                                                                        |
| Access layout     | Compare editable, read-only, redacted, and partially accessible states; verify stable setting order and no restricted value reaches client props or DOM            |
| Aggregate scope   | Verify readable surfaces use the readable set and controls/mutations use the action-eligible set; when they differ, render readable resources and name both scopes |
| Optimistic update | Verify success, rollback, and stale/conflict behavior when implemented                                                                                             |
| Localization/RTL  | Render if supported; otherwise identify the unsupported assumption explicitly                                                                                      |

Do not manufacture states solely to satisfy this matrix. Prove reachability from product behavior first.
