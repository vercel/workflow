---
"@workflow/errors": patch
"@workflow/core": patch
---

Don't set `cause: undefined` as an enumerable own property on `WorkflowError` instances. Previously every no-cause subclass rendered `{ cause: undefined, … }` in `util.inspect(err)` output (Node default formatter, framework dev overlays, structured log dumps); now `cause` is only present when a cause was actually provided.

Also fixes a `[util.inspect.custom]` rendering bug in `ContextViolationError`: multi-line messages caused every framed `╰▶ docs:` detail line to render twice, since the stack-tail-stripping logic only sliced the first message line. The fix counts the actual number of message lines.
