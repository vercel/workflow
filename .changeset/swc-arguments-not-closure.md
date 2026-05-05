---
"@workflow/swc-plugin": patch
---

Stop treating `arguments` as a closure variable when it appears inside a nested `function`-form step body. Previously the hoisted body got an invalid `const { arguments } = ...` destructuring and the original `arguments[N]` access silently broke; now `arguments` reflects the positional args the runtime passes via `stepFn.apply(thisVal, args)`. Also drop dead `ForbiddenExpression` checks for `this`/`arguments` (the directives are stripped before the visitor reaches them, so they were never actually triggered).
