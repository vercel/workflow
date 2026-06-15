---
'@workflow/web': patch
'@workflow/web-shared': patch
---

Fix context card / timestamp tooltip styling: map the Geist `background`/`gray` scales to Tailwind tokens, correct the drifted `--ds-*` neutral values, add the missing `--ds-shadow-tooltip` token, and match the arrow stroke to the card border via `--ds-gray-alpha-400`.
