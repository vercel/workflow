---
"@workflow/core": minor
---

Store deeply frozen values passed between steps, such as results of immer's `produce`, as references and changes instead of full copies. Such values are returned frozen.
