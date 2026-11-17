---
'@workflow/web-shared': patch
'@workflow/web': patch
---

`Spinner` emits its keyframes once per page instead of once per instance, is hidden from assistive tech by default, and accepts a `label` to announce itself as a loading status.
