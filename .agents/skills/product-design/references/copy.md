# Product Copy

Canonical voice and interface-language rules for the observability UI (`packages/web` and `packages/web-shared`). Load this file for user-facing copy, accessible names, or copy review, then load the matching surface reference from [`surfaces.md`](surfaces.md).

## Contents

- [Quick triage](#quick-triage)
- [Voice](#voice)
- [Rules](#rules)
- [Priority gotchas](#priority-gotchas)
- [Banned](#banned)
- [Mechanics](#mechanics)
- [Canonical phrases](#canonical-phrases)
- [Scope guards](#scope-guards)

## Quick Triage

Run substantive checks before punctuation mechanics.

1. Cut banned words and banned product-noun variants. Use [`glossary.md`](glossary.md).
2. Make destructive buttons `Verb + Noun` (`Delete Project`, not `Delete` or `Confirm`). Pair the resulting toast verb exactly.
3. Make errors state what happened and what to do next. Classify the failure before choosing the verb: API, network, build, deploy, and integration failures use `Failed to` or `{Noun} failed`; validation, permission, and user-state failures use `Couldn’t` or `Can’t`. Never normalize every error to `Couldn’t`. Add a stable ID for platform/system errors when one exists.
4. Make the title identify scope: deleting one item and deleting all items must not share an ambiguous title.
5. Use Title Case for label-style UI and sentence case for body or sentence-style actions.
6. Use curly quotes, the ellipsis character (`…`), and the Oxford comma.

Then scan [Priority Gotchas](#priority-gotchas).

Sweep every user-facing string in each in-scope changed UI file, not only the edited line. Fix pre-existing copy defects within the supplied surface; do not expand into unrelated files or product areas.

## Voice

Write like the coworker people trust: clear, competent, and direct.

### Do Not Sound Like

- Corporate bot: _“I’m happy to help you with that!”_
- Apologetic assistant: _“I’m sorry, but I wasn’t able to process your request.”_
- Robot: _“TASK COMPLETED SUCCESSFULLY”_
- Overly casual: _“yo, PR’s up lol”_
- Hype copywriter: _“Seamlessly deploy at blazing speed!”_

### Sound Like

- Sharp teammate: _“Build failed. Bundle exceeds 50 MB. Reduce your bundle or raise the limit in project settings.”_
- Confident and brief: _“Blob deleted”_ · _“Your project is live at yourdomain.com.”_
- Directive and warm: _“Connect your Git repository to start deploying.”_

### Flex Tone With Context

| Context          | Tone                 | Example                                                                                      |
| ---------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| Success          | Brief, confident     | _“Deployed to production”_                                                                   |
| Error            | Direct, helpful      | _“Couldn’t verify your passkey. Try again.”_                                                 |
| Loading          | Reassuring, brief    | _“Saving your work…”_ · _“Verifying…”_                                                       |
| Destructive      | Serious, specific    | _“`my-project` and all its deployments will be permanently deleted. This cannot be undone.”_ |
| Empty/onboarding | Directive, warm      | _“No deployments yet. Push to your Git repository to create your first one.”_                |
| Informational    | Neutral, precise     | _“Usage resets on the 1st of each month.”_                                                   |
| Permission/limit | Direct, route to fix | _“You don’t have permission to delete this project. Ask a team owner.”_                      |

## Rules

### Brief: Every Word Earns Its Place

- Use numerals: `3 projects`, not `three projects`.
- Use contractions with curly apostrophes.
- Drop preambles and filler adverbs: `In order to`, `just`, `simply`, `actually`, `at this time`.
- Drop `successfully` from completion toasts.
- Cut text whose removal does not change meaning.
- Do not repeat a heading in its description or a clear button in helper text.
- Make helpers add information the control cannot show: format constraints, side effects, gating, or time scope. Use [`surfaces-forms.md`](surfaces-forms.md#helper-text-description--hint).

### Clear: Unambiguous, Specific, Consistent

- Use active voice by default. Preserve state labels such as `Ready`, `Building`, and `Queued` when they match the product model.
- Choose error verbs by failure source:

  | Failure                               | Use                           | Example                                    |
  | ------------------------------------- | ----------------------------- | ------------------------------------------ |
  | Validation, permission, or user state | `Couldn’t` / `Can’t`          | `Couldn’t verify your passkey. Try again.` |
  | API, build, deploy, or infrastructure | `Failed to` / `{Noun} failed` | `Build failed. Bundle exceeds 50 MB.`      |

- Preserve an adjacent canonical `Failed to` pattern. Otherwise use `Failed to` for system errors and `Couldn’t` for state/validation errors. Always provide a recovery step when one exists.
- Do not use `Unable to`.
- Name the thing: `Connect your GitHub account`, not `Connect your account`.
- Use one noun per concept across buttons, modals, toasts, and errors.
- Use fragments for short labels/statuses and full sentences for explanations.

### Warm but Not Chatty

- Prefer contractions over formal phrasing.
- Avoid hype, rhetorical questions, `Heads up!`, and humor in errors.
- Use exclamation marks only for genuinely positive moments, never errors.
- Avoid ableist idioms. Prefer second person; use singular `they` when needed.
- Cut `please` and `we’re sorry` unless asking a favor, acknowledging that Vercel is at fault, or asking the user to do something inconvenient.

### Actionable: Guide the Next Step

- State what happened and what the user can do next.
- Reframe blame as action: `Choose a password with at least 8 characters.`
- Make empty states explain the relevant first or recovery action.
- Use `Verb + Noun` for destructive actions. Load [`verbs.md`](verbs.md) and [`patterns.md`](patterns.md#destructive-copy-patterns).
- Make links name their destination; avoid bare `Learn more` and `click here`.
- Route permission denials to the resolver: team owner, plan upgrade, settings, or documentation.

Use `rule/...` slugs from [`rules.md`](rules.md) when reporting copy findings.

## Priority Gotchas

1. **Under-compression.** Multi-paragraph modal bodies often reduce to one precise sentence.
2. **Scope-ambiguous titles.** Distinguish one object from all objects.
3. **Apologetic preambles.** Start with what happened.
4. **Third-person product narration.** Describe the object and consequence, not “Vercel will…”.
5. **`successfully` in toasts.** State the result.
6. **Generic destructive controls.** Replace `Confirm`, `OK`, or a bare verb with `Verb + Noun`.
7. **System errors without a stable ID.** Include a copyable request/deployment/run/trace ID when available; do not invent one.
8. **Transient-only failures.** Keep a short toast, then persist recovery detail and the stable ID where the failure remains relevant.
9. **Toasts that overstate the mutation.** Trace the request body and name the exact field/object that changed.
10. **API failures rewritten as user-state failures.** A failed fetch or mutation remains `Failed to update notification email. Try again.`, not `Couldn’t update…`. Determine the failure source from code; do not choose the friendlier-sounding verb by instinct.
11. **Helpers that paraphrase controls.** Fold necessary meaning into a concise label or remove the helper.
12. **Sentence-shaped buttons forced into Title Case.** Use sentence case for acknowledgments such as `I understand the risk`.

## Banned

### Tier 1: Hard Bans

**Marketing hype / AI-shaped filler:** `seamlessly` · `effortlessly` · `powerful` · `robust` · `leverage` · `unleash` · `reimagine` · `revolutionize` · `game-changing` · `blazing` · `lightning-fast` · `turnkey` · `holistic` · `best-in-class` · `next-generation` · `cutting-edge` · `world-class` · `delve` · `utilize` · `streamline` · `elevate` · `whilst` · `foster` · `harness` · `crafted` · `vibrant` · `myriad` · `plethora` · `testament` · `intricate` · `empower`

**Filler adverbs:** `just` · `simply` · `actually`

**Banned phrases:** `In order to` · `At this time` · `Please try again` · `We apologize` · `An error occurred` · `Something went wrong` (fallback only) · `Please be certain` · `This action is not reversible` · `You must enter a valid…` · `It’s important to note` · `Dive into` · `Embark on` · `Navigate the complexities` · `Unable to`

**Interjections:** `Oops!` · `Uh-oh!` · `Whoops!` · `Yay!` · `Yikes!` · `Heads up!`

### Tier 2: Inclusive Language

Always replace:

- `blacklist` / `whitelist` → `blocklist` / `allowlist`
- `master` / `slave` → `primary` / `replica` or `primary` / `secondary`
- `kill` (process) → `stop` / `end`
- `hang` → `stop responding` / `freeze`
- `man-hours` → `person-hours` / `staff-hours`
- `grandfathered` → `existing` / `legacy`
- Avoid `sanity check`, `crazy`, and `dummy`.

### Tier 3: Avoid by Default

| Word                     | Default              | Allowed in                                       |
| ------------------------ | -------------------- | ------------------------------------------------ |
| `successfully`           | Cut                  | CLI echo, audit logs, API responses              |
| `ensure`                 | Cut as padding       | Real postcondition guarantees                    |
| `unlock`                 | Cut as marketing     | Precise plan-upgrade CTA                         |
| `comprehensive`          | Cut as marketing     | Literal technical scope                          |
| `please` / `we’re sorry` | Cut                  | Favor, Vercel fault, or meaningful inconvenience |
| `navigate` (verb)        | Use `go to` / `open` | Accessibility navigation terminology             |

### AI-Shaped Cadence

Avoid these patterns, not only individual words:

- bold-first bullets on every list item
- `It’s not X—it’s Y` reframes
- `No X. No Y. Just Z.` rhythms
- magic adverbs such as `deeply`, `fundamentally`, and `quietly`
- rhetorical em-dash hinges and em-dash chains
- unnecessary tricolons
- Unicode arrows in prose outside literal navigation paths

## Mechanics

### Capitalization

- Use Title Case for label-style UI: action labels, form labels, tabs, menus, badges, page/modal/section titles, tooltip titles, empty-state titles, and table headers.
- Lowercase articles, coordinating conjunctions, prepositions, and `to` in infinitives. Capitalize the first/last word and all major words.
- Capitalize phrasal-verb auth labels: `Sign Up`, `Log In`, `Log Out`, `Set Up`, `Opt In`. Preserve provider brand strings such as `Sign in with GitHub`.
- Use sentence case for body text, errors, toasts, placeholders, helper text, validation, descriptions, inline prose links, and sentence-style buttons.
- Keep canonical product names from [`glossary.md`](glossary.md) capitalized in body text.
- Treat setting/section headings as labels, not proper nouns, unless the glossary or a dedicated product brand establishes otherwise.

### Quotes

Use literal curly Unicode punctuation (`’`, `“`, `”`). `&rsquo;` is acceptable only in JSX text; do not introduce it in attributes or TypeScript strings. Do not assume lint will correct straight punctuation for you.

### Period Rule

- Omit periods on fragments, labels, statuses, and single-sentence toasts.
- Use periods on complete modal body, validation, helper, Note body, and page-error sentences.
- Put a period on every sentence of a multi-sentence string, including the last, on any surface. A two-sentence toast, empty state, or error takes two periods: `Build failed. Bundle exceeds 50 MB.`, not `Build failed. Bundle exceeds 50 MB`.
- If any list item is a sentence, punctuate every item consistently.

### Accessible Names

- Use `aria-label` only when no visible or associated text names the control.
- Treat an icon-only control’s accessible name as product copy: name the action or destination precisely.
- Do not use `aria-label` to override visible text.
- Keep broader focus, live-region, and loading semantics in `web-interface-guidelines` rather than solving them with copy alone.

### Other

- Use `…`, never `...`, for an ongoing process.
- Use numerals and comma separators at 4+ digits.
- Use the Oxford comma.
- Use hyphens for compound modifiers.
- Use an em dash only when it clarifies cause/effect or status; avoid rhetorical cadence.
- Load [`mechanics.md`](mechanics.md) for dates, units, code, shortcuts, lifecycle labels, pluralization, audit logs, and cron.

## Canonical Phrases

Use these when the situation matches; do not paraphrase without a product reason.

| Situation                      | Canonical phrase                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Irreversible action            | `This cannot be undone.`                                                                               |
| Partially irreversible cascade | `Some effects cannot be undone.`                                                                       |
| Role denial                    | `Only team owners can {verb} {resource}. Ask a team owner.`                                            |
| Plan denial                    | `Upgrade to Pro to {verb} {resource}.`                                                                 |
| Stalled operation              | `Still {verb}ing. Most {operations} finish within {duration}.`                                         |
| Single-filter no results       | `No {items} match your filter. Clear the filter to see all {items}.`                                   |
| Multi-filter no results        | `No {items} match your filters. Try widening the time range or clearing a filter to see more {items}.` |
| Type to confirm                | `To confirm, type the {resource type} name “{name}”` (rendered by `DestructiveConfirmationInput`)      |
| Popup blocked                  | `Couldn’t open the {Feature} popup. Allow popups and try again.`                                       |
| Read-only acknowledgment       | `Done`                                                                                                 |
| Destructive cancellation       | `Cancel`                                                                                               |
| Unsaved-edit cancellation      | `Keep Editing` paired with `Discard Changes`                                                           |

Load [`patterns.md`](patterns.md) and the relevant domain reference for additional canonical language.

## Scope Guards

Do not apply interface-copy rules to:

- test/spec strings unless they assert shipped copy being changed
- console/dev-only errors
- code-prop values that mirror enums, constants, routes, or schema fields
- server errors that never render
- telemetry event names and flag keys
- Storybook metadata
- JSDoc and written documentation
- GraphQL/SQL literals
- marketing/blog/changelog content
