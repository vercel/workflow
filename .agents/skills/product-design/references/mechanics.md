# Mechanics

Formatting conventions for dates, units, shortcuts, lifecycle badges, and code in copy. Load when reviewing values, not voice.

## Contents

- [Mechanics](#mechanics)
  - [Contents](#contents)
  - [Dates and Times](#dates-and-times)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Units and SI Prefixes](#units-and-si-prefixes)
  - [Uptime and Availability](#uptime-and-availability)
    - [Uptime Examples](#uptime-examples)
    - [Uptime Review Checks](#uptime-review-checks)
  - [Beta / Preview / Experimental Badges](#beta--preview--experimental-badges)
  - [Code in Copy](#code-in-copy)
  - [Plural and Singular Agreement](#plural-and-singular-agreement)
  - [Audit Log Event Language](#audit-log-event-language)
  - [Cron Schedule Display](#cron-schedule-display)

## Dates and Times

- **Less than 24h:** relative. `2m ago`, `5h ago` in tables; `2 minutes ago` in prose and tooltips.
- **More than 7 days:** absolute. `Mar 5, 2026`.
- **Tooltips on relative time always show absolute + timezone.**
- **Audit logs, billing, server-generated timestamps:** ISO 8601 UTC. Example: `2026-04-23T14:23:00Z`.

## Keyboard Shortcuts

- Rendered glyphs with thin space: `⌘ K`, `⌥ ⇧ P`.
- OS-split dynamically: `⌘` on Mac, `Ctrl` on Windows/Linux.
- Spell out `Enter`, `Escape`, `Space` on first reference; glyph after.

## Units and SI Prefixes

- Decimal (MB/GB/TB, base-10) is the default across the product. Matches CLI and pricing.
- Binary (MiB/GiB) only when the surface is literally memory.
- `42ms` / `3.4s` with no space in tight tables; `42 ms` / `3.4 s` with a space in prose.

## Uptime and Availability

Apply `rule/uptime-display` to measured uptime and availability percentages in product summaries, tables, chart tooltips, and share images. Preserve distinctions between four and five nines without making imperfect availability appear perfect. These are Vercel display conventions, not a universal reliability standard or a new measurement formula.

- **Use three decimal places below 100%.** Retain trailing zeros: `99.900%`, `99.990%`, `99.999%`. Specify decimal places rather than “five digits,” which is ambiguous for smaller values.
- **Never overstate availability through formatting.** Truncate nonnegative measured percentages to three decimal places rather than rounding upward. Keep underlying precision for aggregation, sorting, and threshold decisions; expose additional source precision in details when available. A positive value below `0.001%` displays as `<0.001%`; confirmed zero displays as `0.000%`.
- **Reserve `100%` for confirmed complete success within the stated measurement scope.** Require observations and complete coverage of that scope. A rounded upstream `100`, missing data, or excluded intervals alone cannot establish complete success. When the source only establishes a rounded value, disclose its precision limit instead of asserting exact success or inventing digits. A measured value below 100 must never display as `100%` or `100.000%`.
- **Establish the measurement window.** Show the period beside the metric or at the chart level. Mark partial coverage visibly, such as `Since Oct 18` or `18 hours of data`, and expose exact start/end timestamps with timezone in details. A partial series may show `100%` only for a clearly stated, fully observed shorter scope; it must not imply complete coverage of the selected longer period.
- **Make comparisons comparable.** Use the same metric definition and time window. If series have different coverage, disclose it beside each affected value and avoid ranking or presenting them as equivalent full-period results. Do not silently shorten the selected window to the intersection of available history.
- **Keep unknown and excluded data distinct from healthy data.** Use `No data`, `Partial data`, or `Excluded`, as appropriate. Show stale measurements with their last-updated time and a stale indication. Chart intervals must distinguish these states from measured success using text or another non-color cue.
- **Distinguish measured availability, current status, and an SLA target.** Name the measured resource and make the methodology accessible: requests, time, or probes; success criteria; weighting; exclusions; and aggregation. A historical percentage does not establish current operational status. Contractual targets retain their published precision, such as `99.99% SLA`; do not reformat targets as measured results.
- **Use one uptime formatter across surfaces.** Apply the same precision and endpoint rules wherever the same measurement appears. Do not change general-purpose percentage formatting, including billing, conversion, or error rates, to enforce this uptime-specific convention.

### Uptime Examples

Values below are percentages on a 0–100 scale, not ratios. The examples assume the source supports the supplied precision; padding a coarse measurement does not make it more accurate.

| Source and scope                                       | Good                           | Bad                                    |
| ------------------------------------------------------ | ------------------------------ | -------------------------------------- |
| Confirmed exactly 100, complete selected window        | `100%`                         | `100.000%`                             |
| 99.9998                                                | `99.999%`                      | `100%`                                 |
| 99.9953                                                | `99.995%`                      | `100.00%`                              |
| 99.9943                                                | `99.994%`                      | `99.99%`                               |
| 99.99                                                  | `99.990%`                      | `99.99%`                               |
| 0.0008                                                 | `<0.001%`                      | `0.000%`                               |
| Confirmed zero                                         | `0.000%`                       | `No data`                              |
| No observations                                        | `No data`                      | `100%`                                 |
| Complete success over only 18 hours of a selected week | `100% · 18 hours of data`      | Unqualified `100%` under `Last 7 days` |
| Excluded interval                                      | `Excluded` with an explanation | A healthy interval labeled `100%`      |
| Contractual target of 99.99%                           | `99.99% SLA`                   | `99.990% uptime`                       |

### Uptime Review Checks

When implementing or reviewing an uptime surface:

1. Verify the metric definition, source precision, coverage, exclusions, and freshness before choosing a label. Confirm that aggregation uses the weighting appropriate to the metric; for example, request success uses successful requests divided by total requests, not an unweighted mean of rates with unequal request counts.
2. Check the example boundaries above, especially exact 100 versus any value below 100, and confirm that displayed truncation does not alter calculations or sorting. Invalid or out-of-range source values must not become success claims.
3. Check full, partial, empty, excluded, and stale states. Compare a newly added provider with a full-window series; ensure coverage differences remain visible without hover.
4. Compare the same measurement across summary, table, tooltip, and share image. Verify text alternatives for chart states and inspect compact layouts so values and coverage qualifiers remain readable.

## Beta / Preview / Experimental Badges

Canonical lifecycle labels (in order from least to most stable):

| Label          | Means                                                              | Tooltip required? | Examples                                          |
| -------------- | ------------------------------------------------------------------ | ----------------- | ------------------------------------------------- |
| `Alpha`        | Unstable, breaking changes expected, internal or invite-only       | Yes               | Pre-release SDK, gated feature in dogfood         |
| `Experimental` | Public but explicitly subject to change without notice             | Yes               | New feature flag exposed for testing in product   |
| `Beta`         | Usable today; bugs expected; no SLA                                | Yes               | Public beta of a stable feature with known limits |
| `Preview`      | Feature-complete preview of an upcoming GA; minor changes possible | Optional          | Pre-GA polish phase                               |
| `Early Access` | Available to a subset of customers (often paid tier or invite)     | Yes               | Enterprise-gated rollouts                         |
| `GA`           | Stable, supported, no badge                                        | n/a               | Default — no badge                                |

Tooltip template when one is required:

```
{Label}: {one-line meaning}. {Specific limit, e.g., "API may change before GA" or "pricing not finalized"}.
```

Place the badge once per surface (on the feature name in the page header or nav), not on every nested button. `Beta` badges are the exception: never place them on navigation links such as the sidebar or tabs. Don’t stack labels (`Alpha Beta Preview` is meaningless).

## Code in Copy

Three components. Pick by structure:

| Use                           | Component                                   | When                                                                 |
| ----------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| Inline word-level code        | `<InlineCode>` (or single backticks in MDX) | Function names, env-var names, short literals (≤30 chars), CLI args  |
| Inline command                | `<Code syntax="...">` (Geist Mono)          | Short commands or paths shown in prose. `syntax` is required.        |
| Multi-line block              | `<CodeBlock>`                               | Multi-step commands, snippets ≥2 lines, anything needing copy button |
| Code with copy button + label | `<Snippet>`                                 | Onboarding flows, key/secret reveal, anywhere user must copy exactly |

Conventions:

- **Authors never type `$` at the start of CLI commands.** `<Snippet prompt={true}>` (the default) and `<CodeBlock>` syntax-highlighting both render the prompt. Passing `text="$ vercel deploy"` results in a doubled `$ $ vercel deploy`. Same rule from the component side: see [`surfaces.md` → Code Display](surfaces-data.md#code-display-code-inlinecode-codeblock-snippet).
- No inline comments inside multi-line blocks (use prose around the block).
- Backtick CLI args in prose: `` `--prebuilt` ``.
- Language hints (`tsx`, `bash`, `json`) on `<CodeBlock>` for syntax highlighting; `syntax` prop on `<Code>` is required.

Copy-action toast convention:

- After click-to-copy: brief toast `Copied` (sentence case, no period — single-word fragment).
- Don’t say `Copied to clipboard` (where else would it go?).

## Plural and Singular Agreement

Interpolated counts must respect singular/plural:

- ✅ `{n} {n === 1 ? 'blob' : 'blobs'}`
- ✅ `{daysRemaining} {daysRemaining === 1 ? 'day' : 'days'} left`
- ❌ `{n} blob(s)` (parenthetical plural is a copy smell)
- ❌ `{n} blobs` (incorrect when n === 1)

For zero-state, often `no` reads better than `0`:

- ✅ `No deployments yet`
- ❌ `0 deployments yet`

## Audit Log Event Language

Audit log entries are immutable, machine-friendly, and human-readable. Past tense, third person, structured.

Pattern: `{actor} {past-tense-verb} {resource} [{qualifier}]`

Examples:

- ✅ `Jane Smith deleted project my-app`
- ✅ `john@vercel.com rotated env var DATABASE_URL in Production`
- ✅ `[Vercel CI] deployed dpl_x7hB2kLm9qR3 to Production`
- ❌ `User has deleted the project` (passive, no actor)
- ❌ `Deletion of project` (nominalization)

Conventions:

- Actor: full name or email or service identifier (in `[brackets]` for system actors)
- Verb: past tense, single word when possible (`deleted`, `created`, `rotated`, `revoked`, `granted`, `signed up`, `logged in`)
- Resource: name + ID when relevant. Quote literals (`"my-app"`).
- Qualifier: scope, environment, target. Examples: `in Production`, `from team Acme Corp`, `via API token key_…`.

Timestamps:

- Always show ISO 8601 UTC in the immutable record (`2026-04-27T14:23:00Z`).
- Display relative time in the UI with absolute on hover.

## Cron Schedule Display

Cron expressions are unreadable to most users. Show both:

- Raw expression in monospace: `*/5 * * * *`
- Humanized form on hover or below: `Every 5 minutes`

For named schedules (`@hourly`, `@daily`), display the keyword + the equivalent expression.

Use `cronstrue` or equivalent for humanization; never hand-write the human form (drift risk).
