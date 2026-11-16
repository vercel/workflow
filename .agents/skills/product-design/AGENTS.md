# Vercel Product Design

This directory is the single entry point for product-design guidance in the observability UI (`packages/web` and `packages/web-shared`). `SKILL.md` owns the runtime workflow; references hold specialized decisions and examples.

## Required Load Order

1. Read `SKILL.md` in full and resolve request mode.
2. For shape, implementation, hardening, full review, or material flow changes, read `references/product-judgment.md` and `references/interface-quality.md`.
3. For user-facing language, read `references/copy.md`, then route through `references/surfaces.md`.
4. For content, network, data, permission, or localization pressure, read `references/resilience.md`.
5. Load only the domain and surface references selected by that router.
6. Load the canonical supporting skill/source for component, design-system, interaction, or final-review claims.

Do not infer a Vercel rule from model memory or one shipped file when a canonical source is unavailable.

## Validation

No automated check covers these files. When editing them, keep relative links, anchors, and `rule/...` slugs in `references/rules.md` resolving.

## Decision Governance

Update the skill only after a human accepts the evidence in pull request review.

Every promoted decision needs:

- a stable evidence link or current-source proof
- scope and explicit exceptions
- rationale tied to user/product consequences
- a bad/good example when the rule is mechanical
- the narrowest correct owner: canonical source, routed reference, exemplar, lint/eval check, or coverage gap

One comment, one screenshot, one code example, or reviewer seniority is prioritization evidence, not enough by itself to establish a universal standard.

## Common Failure Modes

1. **Copy-first work.** Resolve product behavior, component semantics, and states before wording.
2. **Diff-only review.** Review the complete supplied surface and directly coupled states.
3. **Code-only visual approval.** Render visual, responsive, focus, overlay, motion, and overflow claims.
4. **Precedent by frequency.** Repeated shipped code is not automatically canonical.
5. **Happy-path completion.** Verify every reachable state affected by the change.
6. **Rule laundering.** Label heuristics as heuristics; cite canonical rules precisely.
7. **Lint absolutism.** Static findings are prompts for contextual review, not automatic edits.
8. **Output-first design.** Establish the current problem, desired outcome, and success criteria before choosing UI.
9. **Assumption laundering.** Keep facts, decisions, assumptions, and open product choices distinct.
