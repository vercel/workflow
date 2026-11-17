---
'@workflow/web-shared': patch
'@workflow/web': patch
---

The copy button moves to `ui/copy-button` and is built on the shared icon-button styles, with `ghost` and `outline` variants. Call sites no longer restyle it with `!important` overrides, every copy icon is the same size, and a denied clipboard write no longer throws an unhandled rejection.
