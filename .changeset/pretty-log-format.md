---
"@workflow/core": patch
"@workflow/errors": patch
---

Replace `util.inspect`'s default object dump for runtime structured-log metadata with an opinionated, workflow-aware formatter (`packages/core/src/log-format.ts`). The runtime logger now composes `[workflow-sdk] <message>` + stack + a compact, color-coded metadata block — passed to `console.error` / `console.warn` as a single string — instead of letting Node quote-escape multi-line stacks and paragraph hints inside an object dump.

Highlights of the new format:

- `wrun_…` / `step_…` ULIDs render with their parsed friendly name (`add (./workflows/1_simple)`) using the existing `parseStepName` / `parseWorkflowName` utilities.
- Color-coded attribution badge (`user error` red, `sdk error` magenta) paired with the error class in bold.
- `hint` renders as a clean paragraph under `hint:` instead of a backslash-`\n`-escaped string.
- Redundant fields (`errorStack`, plus `errorMessage` when the parent message already includes it) are dropped to avoid double-printing.
- Unknown fields fall through as a sorted `key  value` tail so we never silently drop log information.

Side-effect: `@workflow/errors/ansi` gains `bold`, `red`, `magenta` helpers used by the formatter. The `web` / `web-shared` packages don't consume stderr — they read structured event payloads from the World event log — so the change is presentation-only at the runtime layer.
