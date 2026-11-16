# Interface Quality

Run this review against the current supplied surface, not only the eventual diff. Source reveals behavior and reachable states; rendered evidence reveals hierarchy, layout, and interaction quality.

## Contents

- [Review sequence](#review-sequence)
- [Rendered evidence](#rendered-evidence)
- [Pass criteria](#pass-criteria)
- [Mechanical checks](#mechanical-checks)
- [Finding model](#finding-model)
- [Interface namespaces](#interface-namespaces)
- [Failure patterns](#failure-patterns)

## Review Sequence

Run passes in this order. Earlier decisions constrain later ones.

1. **Product pass.** Load [`product-judgment.md`](product-judgment.md). Verify current problem and evidence, desired outcome, user job, object, scope, consequences, success criteria, permissions, and recovery.
2. **Surface map.** Resolve the URL, screenshot, route, or component to source. List visible regions, overlays, transitions, responsive variants, and reachable states.
3. **Component pass.** Inspect `packages/web/app/components/ui` and `packages/web-shared/src/components/ui`. Verify semantic fit and whether an existing primitive already solves the problem.
4. **Hierarchy/layout pass.** Load the token table in `packages/web-shared/AGENTS.md`. Verify task priority, density, grouping, typography, spacing, alignment, color, and materials.
5. **Interaction/accessibility pass.** Load `web-interface-guidelines`. Verify navigation semantics, keyboard, focus, touch, forms, async behavior, URL state, and motion.
6. **State/resilience pass.** Load [`resilience.md`](resilience.md) when content, network, permissions, localization, or boundary conditions can break the ideal layout.
7. **Copy pass.** Load [`copy.md`](copy.md) and the routed surface references after the interaction and consequence model are known.
8. **Final design-system pass.** Check structural visible changes against `web-guidelines` and the token table before shipping.

Do not start with copy or decoration. Both depend on the product and interaction model.

## Rendered Evidence

Render when the task includes an existing runnable surface and any finding concerns visual hierarchy, layout, responsive behavior, focus, overlays, motion, overflow, or interactive states.

### Minimum viewport matrix

Width selects the layout; height and aspect ratio decide how much of it fits. Cover both.

| Class                      | Viewports                      | What it catches                                             |
| -------------------------- | ------------------------------ | ----------------------------------------------------------- |
| Tall phone                 | 360×800, 390×844               | Narrowest supported width; tall crop                        |
| Short phone / folded       | 375×667, 382×580               | Least vertical room; primary action clipped                 |
| Foldable / short landscape | 594×368, 669×871, 951×589      | Near-square and short landscape; 900–1023px breakpoint seam |
| Split View                 | 385×571                        | Half-window width and reduced height                        |
| Tablet                     | 768×1024, 1024×768             | Orientation and the desktop breakpoint boundary             |
| Desktop                    | 1440×900, 1920×1080, 2560×1080 | Common laptop/desktop and ultrawide max-width               |

- Verify the primary task and its action are visible above the fold at every viewport, or that the surface intentionally signals more content.
- Do not size critical layout from `vh`; browser chrome changes it. Do not trust `screen.width`, `(hover: hover)`, or Device Posture for foldables.
- At 900–1023px, desktop navigation can coexist with a still-stacked layout. Test both 871 and 951px, not just the breakpoint endpoints.
- CSS pixels are the layout contract; DPR changes asset sharpness, not breakpoints. Check 1× and 2× for hairlines, icons, and raster media.

Add a dense/large-data state when content volume affects layout. Do not use a screenshot of one happy-path desktop state as proof of responsive or state completeness.

Render each materially different feature flag, experiment, assisted, and manual path. Combine path coverage with the viewport matrix when differences affect hierarchy, interaction, or responsive behavior.

### Evidence discipline

- Record the route, viewport, state, and interaction exercised.
- Distinguish observed behavior from source-supported inference.
- Treat screenshots and design artifacts as evidence of intent, not proof of product behavior or a mandate for pixel imitation.
- If authentication, environment, or data prevents rendering, report that limitation and use source evidence only.
- Compare before/after views for visible changes when possible.
- For loading changes, capture the ordered sequence under realistic throttling: initial fallback, any intermediate frames, final content, and revalidation. Count the transitions the surface makes and confirm no region starts blank. Also verify the fast or cached path does not flash a fallback. A final screenshot cannot prove transition quality.
- Do not approve a visual change solely because lint, typecheck, or snapshots pass.

## Pass Criteria

### Product

- Is the current user problem established from evidence rather than inferred from the proposed UI?
- Does the interface help the intended user finish the primary job?
- Does the result satisfy observable acceptance criteria and avoid the stated non-goals?
- Does it name the exact object and scope?
- Are timing, side effects, permissions, billing impact, and reversibility clear where they affect consent?
- Does the post-action state match product behavior?
- Do alternate paths converge on the same configuration contract, validation, permissions, and committed result unless an intentional difference is documented?

### Component

- Does every control perform the semantic job its component implies?
- Is an existing Geist primitive available?
- Is the selected surface appropriately persistent and interruptive?
- Are navigation and mutation controls distinct?
- Does the component work at the required density and viewport?

### Hierarchy and Layout

- Is the primary task visually dominant without manufacturing a hero treatment?
- Can the intended user find the current state, available action, and consequence without reconstructing the system model?
- Are related items grouped and unrelated sections separated?
- Does spacing express hierarchy instead of repeating one gap everywhere?
- Are labels, explanations, metadata, and actions visually distinct?
- Does alignment remain stable across loading, error, sparse, and populated states?
- In settings, do permitted-to-know sections and fields keep the same order and geometry across editable, read-only, redacted, plan-gated, and policy-gated states?
- Are containers necessary? Prefer structure and spacing over nested cards.
- Does the interface feel native to the adjacent Vercel product area rather than like a generic generated dashboard?

### Interaction and Accessibility

- Can every task be completed by keyboard with visible focus?
- Does focus enter, stay within, and return from overlays correctly?
- Do touch targets and mobile input behavior meet the routed guidelines?
- Do links navigate and buttons act?
- Do loading, disabled, and optimistic states preserve task identity and prevent duplicate work?
- Do related controls and content reveal as coherent groups without transient placeholders, wrong authorization branches, or repeated skeleton transitions?
- Does every async region start from a fallback that reserves its final geometry rather than from blank space?
- Does the surface settle in the fewest transitions its data allows, with server-rendered structure where the server already knows the answer?
- Do permission- and plan-gated controls render as available while the check is unresolved, instead of using `disabled` to represent loading?
- Are dynamic changes announced without noisy or duplicate live regions?
- Does URL/history state support navigation, refresh, and sharing when the state matters?
- Is motion purposeful, interruptible, and reduced-motion safe?
- For a staged reveal, do visual emphasis, scroll destination and offset, focus destination, and timing preserve continuity? Programmatic scroll and focus must remain interruptible, must not override ongoing input, and should avoid unnecessary mobile keyboard activation.

### State and Resilience

Map only reachable states, then verify each relevant one:

| State                     | Verify                                                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading                   | Loading boundary present, fallback matches the resolved surface type and geometry, bounded reveal groups, minimum transitions, layout stability, honest progress, stable action labels                    |
| Empty/onboarding          | Why it is empty and the valid first action, if the user can act                                                                                                                                           |
| No results                | Active constraint and a way to widen or clear it                                                                                                                                                          |
| Sparse/dense              | Hierarchy holds with one item and many items                                                                                                                                                              |
| Validation                | Input preserved; error is specific and associated                                                                                                                                                         |
| System error              | Persistent recovery when the problem remains; stable ID when available                                                                                                                                    |
| Permission/plan           | Stable permitted-to-know layout; reason and resolver; readable values retained when edit is denied; unreadable values absent from client data and visibly redacted only when their field may be disclosed |
| Partial aggregate access  | Readable surfaces use the readable resource set; controls and mutations use the action-eligible set; differences remain visible and both scopes are named                                                 |
| Optimistic/stale/conflict | Rollback or reconciliation is honest                                                                                                                                                                      |
| Destructive               | Proportional friction, exact scope, accurate recovery                                                                                                                                                     |
| Long/localized/RTL        | No clipping, overlap, fixed-width assumptions, or directional leakage                                                                                                                                     |

Not every view needs every row. Every row the product can enter needs a designed outcome.

### Copy

- Does every string name the correct object, state, and next step?
- Does language reflect the actual mutation and consequence?
- Are product nouns and mechanics canonical?
- Are accessible names consistent with visible labels and control semantics?
- Is every sentence earning its space?

## Mechanical Checks

Run the repository lint checks appropriate to the changed files. Lint catches narrow, source-detectable risks; it does not judge product intent, component fit, hierarchy, or rendered quality. Confirm every finding against context before editing.

### Component and Control Compliance

- Prefer existing local components for ordinary controls, feedback, empty states, menus, and overlays.
- Use `lucide-react` for icons, matching the rest of the package.
- Give icon-only controls a specific accessible name.
- Make visible checkbox/radio/toggle text part of the control’s label and hit target.

### Context Menus and Browser Access

When a dashboard surface uses the shared Geist `ContextMenu`, the first mouse right-click opens the product menu and a second right-click within 500 ms opens the browser’s native menu. Use `ContextMenuTrigger` instead of adding call-site timing or unconditional `preventDefault()` behavior.

This preserves fast access to product actions without removing browser actions such as opening a link in a new tab, copying a link address, saving, or inspecting. The contract applies to mouse secondary clicks on the shared context-menu component. It does not redefine the component’s keyboard invocation or touch/pen long-press behavior.

```tsx
// BAD — every right-click suppresses the browser menu
<div
  onContextMenu={(event) => {
    event.preventDefault();
    openProjectMenu();
  }}
/>

// GOOD — shared trigger preserves the rapid second-click escape
<ContextMenu>
  <ContextMenuTrigger asChild>{projectCard}</ContextMenuTrigger>
  <ContextMenuContent>{projectActions}</ContextMenuContent>
</ContextMenu>
```

### Tokens and Typography

- Use Geist typography, color, radius, material, and spacing tokens.
- Prefer component props and established layout primitives over visual overrides.
- Treat an arbitrary value as a prompt to verify the design-system gap, not an automatic replacement if no equivalent exists.

### Success and Positive Outcomes

- Use `teal-600` for a persistent successful status: an object is active, healthy, available, or provisioned. When a Geist component owns the color, use its teal semantic variant instead of overriding it.
- Use an appropriate blue token for a positive action outcome: a completed confirmation, a checked/verified/configured item, or the affirmative next step after success. `blue-700` is the normal dashboard icon choice on a neutral surface; choose another design-system blue only when the component or contrast requires it.
- Do not use green as generic Vercel success. Green remains valid only when a named product taxonomy or canonical component contract specifically owns it; do not mechanically recolor existing code without checking that model.
- Color reinforces the visible status text and icon; it is never the only success cue.

```tsx
// BAD — generic confirmation uses green
<IconCheckCircleFill color="green-700" />

// GOOD — completion enables the user's next positive action
<IconCheckCircleFill color="blue-700" />

// GOOD — persistent resource status
<Badge variant="teal-subtle">Provisioned</Badge>
```

### Feedback and Async

- Use persistent feedback for unresolved page/section failures and include recovery when available.
- Keep an action’s label stable while loading; use the component’s busy/loading API.
- Preserve user input on validation and recoverable request errors.

## Finding Model

Order findings by impact:

- **P0:** blocks the primary task, causes severe accessibility failure, or risks unrecoverable harm.
- **P1:** likely task failure, misleading consent/consequence, missing critical state, or major responsive/accessibility defect.
- **P2:** meaningful friction, inconsistency, weak hierarchy, or recoverability issue.
- **P3:** minor craft or consistency improvement.

Each finding must include:

1. file/line or rendered location
2. verification status (`Verified`, `Source-verified`, `Inferred`, or `Unverified`)
3. canonical source/section or accepted decision
4. user consequence
5. smallest concrete fix

Do not use aesthetic preference as a finding. Do not assign a numerical quality score.

## Interface Namespaces

Use `interface/...` only for orchestration findings owned by this skill:

| Namespace                           | Meaning                                                                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interface/product-model`           | The UI decision was made without establishing user job, object, scope, or consequence.                                                                                           |
| `interface/source-required`         | A structural finding lacks a loaded canonical source or accepted decision.                                                                                                       |
| `interface/request-mode`            | Work was silently narrowed or broadened beyond the request mode.                                                                                                                 |
| `interface/render-required`         | A visual/interaction claim was made without rendered evidence.                                                                                                                   |
| `interface/state-completeness`      | A reachable state lacks a coherent outcome or recovery path.                                                                                                                     |
| `interface/no-dead-end`             | The user cannot continue, recover, or understand why no action exists.                                                                                                           |
| `interface/component-compliance`    | A control bypasses an available semantic Geist primitive or required API.                                                                                                        |
| `interface/typography-tokens`       | Typography, spacing, or color uses an arbitrary value where a Geist token or component API should be evaluated.                                                                  |
| `interface/success-color`           | Generic success uses green, or status and affirmative-action color semantics are conflated.                                                                                      |
| `interface/loading-label-stability` | A loading control changes task identity or loses focus.                                                                                                                          |
| `interface/loading-sequence`        | A fallback mismatches final geometry, a coherent group pops in piecemeal, or initial loading replays after reveal.                                                               |
| `interface/loading-boundary`        | An async region paints blank before its first content instead of a fallback that reserves its final geometry.                                                                    |
| `interface/transition-budget`       | The surface settles through more transitions than its data requires, or independent regions popcorn where one grouped reveal would do.                                           |
| `interface/permission-optimism`     | A control renders disabled, hidden, or gated because a permission, role, or plan check is unresolved rather than because the user lacks the capability.                          |
| `interface/navigation-boundary`     | An external icon appears for a Vercel destination, is missing for a non-Vercel destination, or new-tab behavior lacks a reason to keep the user's current Vercel work available. |
| `interface/context-menu-escape`     | A custom secondary-click menu suppresses the shared Geist behavior that keeps the browser’s native menu available on a rapid second right-click.                                 |
| `interface/control-name`            | An icon-only or no-visible-text control lacks a specific accessible name.                                                                                                        |
| `interface/label-hit-target`        | Visible control text is detached from its interactive label/hit target.                                                                                                          |
| `interface/feedback-surface`        | Feedback persistence does not match the duration of the problem.                                                                                                                 |
| `interface/responsive-proof`        | Responsive approval lacks compact/boundary evidence.                                                                                                                             |

## Failure Patterns

- **Copy-first sequencing:** wording is polished before the interaction and consequence model is settled.
- **Diff-only review:** existing defects in the supplied surface are ignored because the changed lines did not introduce them.
- **Screenshot-only review:** one visual state is treated as proof of behavior and completeness.
- **Code-only visual approval:** source inspection is mislabeled as rendered verification.
- **Precedent by frequency:** a repeated pattern is assumed correct without canonical support.
- **Generic dashboard reflex:** every view becomes cards, metrics, and equal-weight controls regardless of task.
- **Container inflation:** cards, borders, and helper text compensate for weak grouping.
- **Output-first design:** a requested component or mockup is implemented before verifying the user problem and desired outcome.
- **Configuration reflex:** a new setting is added where a safe default or direct behavior would solve the job.
- **Assumption laundering:** an unverified preference, policy, or user need is presented as a product requirement.
- **Happy-path completeness:** populated desktop is polished while loading, errors, permissions, and narrow widths fail.
- **Final-frame approval:** the resolved screenshot looks correct while mismatched fallbacks, partial reveals, or transient wrong states remain unexamined.
- **Popcorn loading:** each region gets its own boundary and resolves on its own schedule, so the page settles in a sequence of unrelated jumps.
- **Disabled-as-loading:** unresolved permissions or pending data are expressed by greying controls out, so a normal load looks like a permissions denial.
- **Rule laundering:** a general heuristic is presented as a Vercel standard.
