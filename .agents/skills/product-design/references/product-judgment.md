# Product Judgment

Use this reference before choosing components, layout, or copy for a new or materially changed product flow. It turns product behavior into interface decisions.

## Contents

- [Frame the outcome](#frame-the-outcome)
- [Start from the job](#start-from-the-job)
- [Build the consequence model](#build-the-consequence-model)
- [Compare solutions and tradeoffs](#compare-solutions-and-tradeoffs)
- [Choose the interaction](#choose-the-interaction)
- [Structure information](#structure-information)
- [Design assisted authoring and recommendations](#design-assisted-authoring-and-recommendations)
- [Define success and rollout](#define-success-and-rollout)
- [Use evidence correctly](#use-evidence-correctly)
- [Keep a decision record](#keep-a-decision-record)
- [Decision checks](#decision-checks)

## Frame the Outcome

Define the product problem before proposing interface output.

| Question                                                     | Required result                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Who experiences the problem, in what context, and how often? | Target user and workflow, without flattening experts and first-time users.      |
| What happens today?                                          | Current behavior, workaround, friction, or risk established from evidence.      |
| What should become easier, safer, faster, or clearer?        | Desired user outcome stated independently of a component or layout.             |
| How would we know it worked?                                 | Observable task outcome or quality signal; not merely a click on the new UI.    |
| What is intentionally not changing?                          | Non-goals that prevent a local decision from becoming an accidental redesign.   |
| Which constraints are fixed and which are choices?           | Technical, policy, business, timing, and compatibility constraints kept honest. |

Do not invent research, frequency, urgency, or business goals. Use supplied evidence and current source. If a missing choice would materially change the product, surface it as an open decision instead of burying a guess in code.

## Start From the Job

Write a compact brief from evidence already in the request and repository:

| Question                                                                   | Why it changes the design                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------- |
| Who is acting and what are they trying to finish?                          | Establishes the primary task and expected expertise.     |
| What exact object are they viewing or changing?                            | Determines nouns, scope, and component context.          |
| Is the action navigation, selection, configuration, creation, or mutation? | Determines semantic control and surface.                 |
| What must the user know before acting?                                     | Determines hierarchy and progressive disclosure.         |
| What changes afterward?                                                    | Determines confirmation, loading, success, and recovery. |
| What constraints are real?                                                 | Prevents decorative or impossible designs.               |

Do not turn every brief into a beginner flow. Vercel users often need dense technical context. Make complexity available when it supports the job, while keeping the default path clear.

## Build the Consequence Model

Trace the action through handlers, request payloads, APIs, types, and resulting state. Establish:

1. **Object:** the exact resource or field that changes.
2. **Scope:** project, team, account, environment, deployment, or a specific resource.
3. **Timing:** immediate, queued, delayed, or effective on a later deployment/billing cycle.
4. **Duration:** transient, persistent, or permanent.
5. **Reversibility:** undo, restore, recreate, or irreversible.
6. **Cascade:** dependent resources, traffic, data, security/privacy, permissions, billing, or users affected.
7. **Authority:** role, ownership, plan, policy, or configuration required.
8. **Failure/recovery:** validation, conflict, permission, system failure, retry, rollback, or support path.
9. **Result:** what visibly changes and where the user goes next.

The interface must communicate the dimensions that materially affect consent or task success. Do not describe consequences the system does not guarantee.

## Compare Solutions and Tradeoffs

For material changes, compare the smallest credible options:

1. Improve behavior or defaults without adding UI.
2. Reuse or extend an existing surface and mental model.
3. Introduce a new interaction or surface.

Evaluate options against user frequency and expertise, task success, consequence/risk, consistency with the product area, implementation complexity, and long-term maintenance. Prefer the simplest option that fully solves the verified job. Do not create a compromise interface that exposes every internal concern equally.

Record why the selected option wins and which cost it accepts. Skip formal alternatives when the change is mechanical or the product decision is already accepted.

## Choose the Interaction

Choose semantics before appearance.

### Navigation or Action

- Use a link when activation changes location and should support open-in-new-tab semantics.
- Use a button when activation mutates state, opens a task surface, or performs an in-place action.
- Use a `ButtonLink` only when navigation needs button prominence.

### Inline, Overlay, or Page

- Keep simple, local edits inline when context remains clear.
- Use a popover/menu for short, non-blocking choices anchored to a trigger.
- Use a modal/dialog for a focused interruption, confirmation, or bounded task that benefits from retaining page context.
- Use a drawer/sheet when the interaction is spatially secondary or needs mobile-appropriate continuation.
- Use a page for complex, linkable, long, or multi-section tasks. A modal with many fields is usually a page trying to escape.

### Choice Controls

- Use a toggle for one boolean setting.
- Use radio controls for a small visible set where comparison matters.
- Use a segmented switch for named modes, not an on/off setting.
- Use a select for a manageable list and a combobox when search materially reduces effort.
- Use checkboxes for independent multi-selection, not mutually exclusive modes.

Inspect `packages/web/app/components/ui` and `packages/web-shared/src/components/ui` for the current component inventory and exact APIs.

### Destructive Actions

Match friction to impact:

- Low-impact and reversible: act directly and offer undo when the backend can honor it.
- Meaningful but recoverable: confirm the object and consequence.
- High-impact, cascading, or irreversible: require explicit confirmation proportional to risk.

Do not add type-to-confirm friction merely because a button is red. Do not promise undo when the action has already propagated beyond reliable reversal.

## Structure Information

- Put the primary task, current state, and primary action first.
- Resolve scope or authority before presenting choices whose validity, destination, or permissions it changes. Keep established scope visible without displacing the primary task.
- Order setup by dependency: purpose and required context before derived choices; tuning controls after the behavior they tune.
- Group controls by the user’s mental model, not by API payload shape or implementation ownership.
- Separate concepts that have different user roles, permissions, or side effects even when they share an API or backend.
- Keep one clear primary action per task surface.
- Use progressive disclosure for advanced or infrequent controls. Do not hide information required for informed consent, including material privacy, retention, cost, permission, scope, compatibility, or recovery choices.
- Prefer recognition over recall: show current values, scope, dependencies, and consequences near the decision.
- Keep metadata subordinate to the task without removing information experts need.
- Use hierarchy and spacing before adding a card, divider, icon, or helper paragraph.
- Preserve stable locations for recurring actions and status.

When one control changes the valid values of another, preserve a compatible selection. If it becomes invalid, use a documented safe fallback only when the consequence is low and clear; otherwise clear it and require explicit reselection. Communicate the change or unavailable result. Do not mutate unrelated defaults.

## Design Assisted Authoring and Recommendations

Treat an assistant as a proposal mechanism, not an alternate product contract.

- Classify each field as user-authored, system-defaulted, derived, or assistant-proposed. Do not silently overwrite explicit user input.
- Name the artifact and scope of generation: goal, draft, instructions, setup, or another concrete result. Do not imply completion when review or configuration remains.
- Assisted and manual paths should converge on the same configuration contract, validation, permission checks, and committed result unless an intentional difference is part of the product decision. Editability follows field ownership.
- When manual entry is supported, provide an explicit escape from assistance that preserves current work. Its prominence may be secondary to the intended default, but generation must not be required to reach configuration.
- When regeneration or a path change would replace user-authored or edited proposed content, preserve or merge it, warn and confirm replacement, or offer recovery according to the field-ownership contract. Route cancellation, stale results, and degraded behavior through [`resilience.md`](resilience.md).
- Ground recommendations in available product capabilities. Make them concrete, outcome-led, materially distinct, and safe to apply. Return fewer high-quality options instead of filling a quota with near-duplicates.
- Make selection effects predictable. A recommendation may populate fields it clearly represents; it should not change independent defaults without an explicit contract.

## Define Success and Rollout

Turn the decision into observable acceptance criteria:

- the intended user can enter, complete, cancel, and recover from the task
- the resulting state and next step match product behavior
- permissions, billing, destructive effects, and delayed effects are represented honestly
- affected existing workflows continue to work
- changed responsive and boundary states remain usable

For material behavior changes, identify migration, default, discoverability, compatibility, rollout, and rollback implications. Do not add analytics by default. When measurement is in scope, define a user outcome or failure signal first, then route instrumentation to the repository’s analytics guidance.

For a feature flag, experiment, or alternate entry path, record the default and eligibility, entry and exit, shared completion contract, intentional differences, disabled behavior, and rollback. Compare success and failure outcomes across variants, not only exposure or clicks. Collection or external transmission of raw user-authored content requires confirmation of the applicable privacy and data-governance policy and necessity: purpose, whether a less sensitive representation works, recipients and access, retention, and deletion. Route event schema and instrumentation to the repository’s analytics guidance.

## Use Evidence Correctly

### Strong evidence

- repeated, current user research, support evidence, or behavioral data tied to the same problem and population
- current API/data behavior and authoritative types
- Geist component source and style guidance
- an accepted product brief, specification, or design decision with stable evidence and clear scope
- a repeated, current pattern in the same product area that survives canonical checks
- rendered behavior reproduced in the current interface

### Weak evidence

- one anecdote, stakeholder preference, or uncontextualized metric
- the proposed mockup or component choice presented as proof of the problem
- one old component
- one screenshot without state/context
- a code search count
- generic design-system memory
- a third-party heuristic that conflicts with Geist or product behavior

Code search establishes prevalence, not quality. A repeated defect is still a defect. External heuristics may suggest questions, but Vercel product truth and Geist remain authoritative.

## Keep a Decision Record

For material decisions, keep four categories distinct:

- **Facts:** verified user, system, product, or canonical-source behavior.
- **Decisions:** choices made for this scope and their rationale.
- **Assumptions:** unverified premises accepted temporarily, with risk if wrong.
- **Open decisions:** choices that require a human, policy, or evidence unavailable in the task.

Do not present assumptions as requirements. Make the record detailed enough for another human or agent to continue without rediscovering why the interface works this way.

## Decision Checks

Before implementation, verify:

- [ ] Current behavior, user friction, desired outcome, success signal, and non-goals are explicit.
- [ ] The primary user job is explicit.
- [ ] The action’s object, scope, timing, and consequence are known.
- [ ] Material alternatives and tradeoffs were considered without inventing busywork.
- [ ] The chosen component matches the semantic job.
- [ ] The surface is no more interruptive than necessary.
- [ ] Required context is visible at the decision point.
- [ ] Advanced complexity remains available without overwhelming the default path.
- [ ] Reachable states and recovery paths are mapped.
- [ ] The decision cites evidence stronger than personal taste or one adjacent file.
- [ ] Facts, assumptions, decisions, and open decisions are not conflated.
- [ ] Acceptance criteria describe observable user and system behavior.
