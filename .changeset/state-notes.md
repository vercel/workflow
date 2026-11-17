---
'@workflow/web-shared': patch
---

Render the error, data-expired and encrypted states on one shared `Note` component. The error card's details sit behind a native disclosure, the event details and stream viewer errors use the error note, and a stream read error now shows above the chunks already received instead of replacing them.
