---
"@workflow/core": patch
---

Preserve the `this` binding of bound step proxies across workflow serialization, so passing `useStep(...).bind(thisArg)` as a step argument no longer loses the receiver.
