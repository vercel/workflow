---
'@workflow/web-shared': patch
---

Drop the stream identity cluster from the Streams viewer header — the sidebar owns identity and selection, so the header keeps only live state, chunk count, and the view toggle.
