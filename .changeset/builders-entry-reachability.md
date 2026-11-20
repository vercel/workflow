---
"@workflow/builders": patch
---

Step bundle builds no longer slow down quadratically as step files grow. With `externalizeNonSteps`, the SWC plugin now works out once per build which files lead to or come from a step, serde or built in entry, instead of walking the import graph again for every entry on every resolved import. The bundled output is unchanged
