---
name: product-design
description: >-
  Single entry point for product design and user-facing product implementation
  in the workflow observability UI (packages/web and packages/web-shared). Use whenever work changes what a user sees, understands,
  chooses, or does: shaping requirements and flows; building or redesigning
  pages and components; reviewing URLs, screenshots, diffs, or review
  findings; improving product copy, information architecture, component choice,
  Geist compliance, hierarchy, layout, interaction, accessibility, responsive
  behavior, and loading, empty, error, permission, billing, or destructive
  states. Trigger on design, UX, UI, usability, flow, onboarding, settings,
  dashboard, build, improve, fix, audit, review, polish, simplify, or
  production-ready requests. Also use when backend behavior changes a
  user-visible outcome. Not for backend-only work with no user-visible effect,
  tests with no shipped UI impact, telemetry-only work, documentation, or
  marketing content.
---

# Vercel Product Design

Make the interface correct for the user, the product, and Vercel. Working code is not enough: choose the right interaction, make scope and consequences clear, cover reality beyond the happy path, and verify the rendered result.

## Local Context

This skill covers the workflow observability UI:

- `packages/web` is the standalone observability app (`workflow web`), built with React Router 7, Vite, Tailwind 4, and shadcn/Radix primitives in `app/components/ui`.
- `packages/web-shared` holds the trace viewer, event list, stream viewer, and sidebar panels. The same components also render inside the Vercel dashboard, so they must look native there.
- Colour and typography use the dashboard's Geist tokens. [`packages/web-shared/AGENTS.md`](../../../packages/web-shared/AGENTS.md) is the canonical token table.
- The references name Geist components (`Modal`, `EmptyState`, `Note`, `Breadcrumbs`, and similar). Neither package depends on Geist components: map each one to the closest local component in `packages/web/app/components/ui` or `packages/web-shared/src/components/ui` and apply the same copy, state, and interaction rules. Don't add a Geist dependency to match a reference.
- Dashboard-only concepts in the references (teams, plans, billing, deployments, settings pages) apply only when the observability UI shows them.

## Operating Contract

- **Start with the job, not the pixels.** Identify who is acting, what they are trying to accomplish, the product object involved, and what the system will change.
- **Define the outcome before the output.** Establish the current user problem, desired behavior, success signal, and non-goals before choosing a surface or component.
- **Use evidence, not taste.** Trace decisions to product behavior, canonical repository guidance, an accepted design decision, or a verified adjacent pattern.
- **Separate facts from decisions.** Mark assumptions and unresolved product choices explicitly; do not hide them inside implementation details.
- **Treat shipped code as evidence, not automatic precedent.** It proves what exists, not why it is correct. Check it against current components, product behavior, and explicit guidance.
- **Choose the smallest coherent intervention.** Consider better defaults, behavior, or reuse before adding UI. Do not solve one job by creating unrelated settings or abstractions.
- **Decide before decorating.** Resolve information architecture, component semantics, interaction, and state behavior before styling or rewriting copy.
- **Design every reachable state.** Include only states the product can actually enter, but do not stop at the populated success case.
- **Verify the real surface.** Source inspection establishes behavior; a rendered interface establishes visual and interaction quality. Never claim visual verification from code alone.
- **Keep one user-facing entry point.** Invoke `product-design`; route internally to the canonical sources below.

## Request Modes

Resolve the mode from the user’s verb and artifact before acting.

| Mode      | Typical request                                                                    | Required behavior                                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape     | “Design this flow”, “How should this work?”, feature brief without settled UI      | Frame the problem and evidence, compare material alternatives, then define the flow, states, acceptance criteria, risks, and open decisions. Do not edit unless asked. |
| Implement | “Build”, “fix”, “improve”, “make compliant”, or “run product-design on everything” | Resolve material product decisions, then implement the smallest coherent end-to-end change within scope. Do not absorb unrelated review findings.                      |
| Review    | “Audit”, “critique”, “what’s wrong?”, code review                                  | Inspect source and rendered evidence, then report prioritized findings. Do not edit unless asked.                                                                      |
| Copy      | “Fix the copy”, “rewrite these errors”                                             | Edit user-facing language, accessible names, and directly required JSX only. Report structural blockers without silently broadening scope.                             |
| Harden    | “Polish”, “production-ready”, “handle edge cases”                                  | Preserve the settled product direction while fixing state, resilience, responsive, accessibility, and finish defects.                                                  |

When intent is ambiguous, use the narrowest mode supported by the verb. A URL, screenshot, route, or component identifies scope; it does not by itself authorize edits.

A material decision changes the user’s task, default, scope, consequence, navigation, interaction surface, or reachable states. Copy mechanics, token replacement, and established component substitutions usually are not material.

## Decision Authority

Resolve conflicts in this order:

1. The user’s explicit goal and constraints.
2. Verified user/product evidence and system truth: research or feedback, API behavior, permissions, billing semantics, data model, and reachable states.
3. Repository-canonical guidance: the `AGENTS.md` chain, the token table in `packages/web-shared/AGENTS.md`, local component APIs, and routed skills.
4. Accepted product/design decisions and exemplars with stable evidence.
5. Verified adjacent shipped patterns in the same product area.
6. General interface heuristics.

Do not let a lower source override a higher one. When sources conflict or rationale is missing, preserve product truth, choose the least speculative option, and state what remains unverified.

## Workflow

### 1. Set scope and mode

Name the target surface and request mode in the work plan or review notes. Include the route/component, entry and exit points, reachable overlays, and directly coupled files. For material work, name explicit non-goals. Do not turn a bounded request into a product-wide redesign.

### 2. Load product context

Before proposing UI:

- Read the applicable `AGENTS.md` chain.
- Read supplied briefs, designs, research, support evidence, analytics, or accepted decisions. Treat absent evidence as unknown, not permission to invent it.
- Resolve any supplied URL, screenshot, route, or component to source.
- Establish current behavior and the user-visible failure or opportunity before proposing the future state.
- Read the product logic that determines mutations, permissions, validation, errors, and side effects.
- Inspect the current component implementation and at least one relevant adjacent Vercel surface.
- Identify which package owns the surface. Code in `packages/web-shared` ships inside the Vercel dashboard too, so keep it free of `packages/web`-only assumptions such as its router, data hooks, or theme provider.

Do not ask the user for facts that source, types, APIs, or the rendered product can establish. Ask when an unresolved preference, policy, target user, or business tradeoff would materially change the product and cannot be established from evidence.

### 3. Model the product decision

For Shape, Implement, Harden, full Review, or any material product/flow change, read [`product-judgment.md`](references/product-judgment.md) and write a compact internal brief:

- user and job
- current behavior, friction, and evidence
- desired outcome, success signal, and non-goals
- object and scope
- action and consequence
- reversibility and recovery
- permissions, plan, and timing
- primary next step
- field ownership and path convergence when a system or assistant proposes configuration
- constraints, assumptions, and open decisions

If any item changes the component or flow, settle it before implementation.

For narrow Copy mode, establish the object, behavior, consequence, and state from source, then skip the full brief unless the language exposes an unresolved product decision.

### 4. Map the surface and states

Inventory entry points, visible regions, overlays, transitions, exits, and return paths. Include assisted and manual paths plus every materially different feature flag or experiment variant. Map only reachable states, including relevant loading, empty, sparse, populated, validation, error, permission, disabled, optimistic, stale, destructive, and responsive variants. Record any state that cannot be inspected.

### 5. Load the routed references

Read each selected reference in full before editing.

| Need                                                             | Load                                                                                                                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product/flow/component decision                                  | [`product-judgment.md`](references/product-judgment.md) + the existing components in `app/components/ui` and `web-shared/src/components/ui`                     |
| Assisted authoring, recommendations, or generated configuration  | [`product-judgment.md`](references/product-judgment.md) + [`surfaces-forms.md`](references/surfaces-forms.md) + [`resilience.md`](references/resilience.md)     |
| Implementation, material visual change, or full review           | [`interface-quality.md`](references/interface-quality.md)                                                                                                       |
| Copy or accessible names                                         | [`copy.md`](references/copy.md) + [`surfaces.md`](references/surfaces.md) routing                                                                               |
| Uptime or availability percentages                               | [`mechanics.md` → Uptime and Availability](references/mechanics.md#uptime-and-availability)                                                                     |
| Layout, typography, color, spacing, Geist tokens                 | [`packages/web-shared/AGENTS.md`](../../../packages/web-shared/AGENTS.md)                                                                                       |
| Keyboard, focus, forms, touch, animation, URL state, performance | `web-interface-guidelines`                                                                                                                                      |
| Overflow, localization, extreme data, network/error resilience   | [`resilience.md`](references/resilience.md)                                                                                                                     |
| Loading, skeletons, streaming, or route-level fallbacks          | [`surfaces-feedback.md` → Loading](references/surfaces-feedback.md#loading-skeleton-spinner-loadingdots-progress) + [`resilience.md`](references/resilience.md) + `web-guidelines` |
| Design artifact implementation                                   | Treat the artifact as intent evidence, not product-behavior truth                                                                                               |
| Observability UI conventions, dialogs, tests                     | `web-guidelines`                                                                                                                                                |

If a routed skill is unavailable, read its local `SKILL.md`. If the canonical source cannot be loaded, do not present a structural judgment from memory as a Vercel rule.

### 6. Decide, then implement

For each non-mechanical change, be able to answer:

- What user problem does this solve?
- Why is this component/surface appropriate?
- What consequence or system state must the interface communicate?
- Which evidence supports the decision?
- What simpler or existing option was considered, and why is this better?
- What is the smallest coherent change?

For material decisions, compare plausible alternatives and record the rejected tradeoff; do not manufacture options for trivial changes. Convert the chosen behavior and states into observable acceptance criteria before coding.

Use existing components and tokens before adding wrappers, variants, or custom behavior. Preserve expert density where it supports the job; progressive disclosure should make complexity available, not erase it. Do not add telemetry, backend capability, or policy changes unless the user’s scope includes them.

### 7. Verify

Verification is part of the design work.

1. **Outcome and behavior:** confirm the primary job and acceptance criteria; trace data and mutations; run focused tests and type checks appropriate to changed code.
2. **Static checks:** run the repository lint checks appropriate to the changed files. Treat findings as review prompts, not automatic truth.
3. **Rendered surface:** inspect compact, short-landscape, wide, and ultrawide viewports using the [minimum viewport matrix](references/interface-quality.md#minimum-viewport-matrix). Render each materially different flag, experiment, assisted, and manual path. Verify hierarchy, alignment, overflow, density, and actual component behavior.
4. **States:** exercise every materially changed reachable state, including failures and permissions. Use source-supported mocks or fixtures; source-review lower-risk states that cannot be rendered and mark the gap. Do not invent impossible states.
5. **Interaction:** verify keyboard order, focus movement/return, loading behavior, pointer/touch targets, and reduced motion where relevant. For loading changes, capture ordered frames under realistic throttling and verify skeleton fidelity, no blank first paint, coherent reveal groups, the transition count, render readiness, and that revalidation does not restore the initial fallback. For staged reveals, verify the visual anchor, scroll destination and offset, focus destination, timing relationship, and interruption behavior.
6. **Resilience:** test long content, large values, constrained width, and localization/RTL risk when the surface can receive them.
7. **Final review:** check structural visible changes against `web-guidelines` and the token table in `packages/web-shared/AGENTS.md`, then rerun relevant lint checks after fixes.

After accepting review findings, rerun the affected product, state, rendered, responsive, and interaction passes. A review is not complete when the prose is acknowledged but the changed path is unverified.

State exactly what was rendered and exercised. “Code looks correct” is not visual verification.

## Completion Contract

- **Shape:** provide the problem and evidence, target user/job, desired outcome, decision and tradeoffs, flow and state model, acceptance criteria, risks, assumptions, and unresolved decisions.
- **Implement/Harden:** report the user-visible behavior changed, material decisions made, tests and rendered states verified, and any unverified state or follow-up.
- **Review:** lead with prioritized findings using the evidence model below. Do not edit, assign a score, or turn preferences into defects.
- **Copy:** report the surfaces changed and any structural blocker left unresolved. Do not imply copy fixes corrected product behavior when they did not.

Keep internal briefs compact. Expose decision detail when another human or agent needs it to review, implement, or continue the work.

## Product Design Standards

- Make the user’s primary task and primary action unmistakable.
- Preserve the user’s mental model and current context unless changing it solves a verified problem.
- Name the exact object, scope, and consequence of important actions.
- Use navigation components for navigation and action components for actions.
- Choose surface persistence to match importance: transient feedback for transient confirmation; persistent feedback for unresolved problems.
- Prefer inline disclosure before adding a modal. Use an overlay only for a focused interruption or task that must retain context.
- Expose advanced controls when needed without making the default path carry their complexity.
- Prefer strong defaults and direct behavior over adding configuration the user must learn and maintain.
- Use the existing semantic components in `app/components/ui` and `web-shared/src/components/ui` before custom HTML or styling.
- Preserve access to browser-native actions when custom interactions replace browser defaults.
- Use hierarchy, spacing, and alignment before adding containers. Cards are not a default grouping mechanism.
- Preserve user input through validation and recoverable errors.
- Render on the server whatever the server already knows, and give every async region a fallback that reserves its final geometry. No region starts blank.
- Spend as few transitions as the data allows between first paint and settled content, and group the ones that remain so the surface does not popcorn.
- Assume the user has permission while the check is unresolved. Disabled means the user cannot act; it is never a loading state.
- In organization, team, and project settings, preserve the product map across resolved access states: keep permitted-to-know sections and fields in place, retain readable values when only editing is denied, and redact values the user cannot read without fetching or exposing them.
- Scope aggregate settings and results to the resources the user can access, and name that scope anywhere a count, filter, export, “all” control, or bulk action could imply a broader set.
- Keep loading control labels stable; use the component’s loading/busy affordance.
- Make destructive actions proportional to impact and provide undo when the system can honestly support it.
- Do not add decorative novelty, motion, or copy unless it clarifies structure, state, or brand intent.

## Review Output

Lead with findings, ordered by user impact:

- **P0:** blocks the primary task, creates severe accessibility failure, or can cause unrecoverable user harm.
- **P1:** likely task failure, misleading consequence, missing critical state, or major responsive/accessibility defect.
- **P2:** meaningful friction, inconsistency, weak hierarchy, or recoverability issue.
- **P3:** minor craft or consistency improvement.

For each finding include: file/line or rendered location, verification status, canonical source, user consequence, and smallest concrete fix. Mark evidence as:

- **Verified:** observed in source plus rendered/runtime behavior.
- **Source-verified:** established by code/product behavior but not rendered.
- **Inferred:** plausible from available evidence; explain the inference.
- **Unverified:** needs a state, viewport, design artifact, or product decision that was unavailable.

Do not assign broad quality scores. They create false precision and hide the few decisions that matter.

## Skill Integrity

This skill encodes accepted decisions, not every opinion found in code or review discussion.

- Add or change a rule only after current-source verification and human acceptance in pull request review.
- Record scope, rationale, evidence, exceptions, and a bad/good example.
- Prefer the narrowest destination: canonical source, routed reference, exemplar, lint/eval check, or coverage gap.
- Keep deterministic checks mechanical. Keep judgment in prose with its evidence and degree of freedom.
- Re-verify fast-changing product names, plans, limits, prices, permissions, and API behavior against current sources before using a reference as truth.
- Never promote one screenshot, one shipped file, or one reviewer comment into a universal rule by itself.

## Scope Guards

Skip backend-only strings and behavior with no user-visible effect, telemetry taxonomy, console/dev errors, generated files, Storybook metadata, and tests with no shipped UI impact. A product-design brief may name a success signal, but instrumentation requires explicit scope. Keep tests aligned when shipped behavior or copy changes. Documentation follows the documentation standards in the root `AGENTS.md`.
