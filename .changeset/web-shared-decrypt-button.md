---
'@workflow/web-shared': patch
'@workflow/web': patch
---

Every decrypt control in the observability UI is now `DecryptButton`, built on the shared `Button` instead of injected CSS. It gains a `size` prop (`small` or `tiny`), shows why decryption is unavailable in a tooltip that is also the button's accessible description, and stops click propagation. The "Decrypted" state is removed: `decrypted` is deprecated and renders nothing, so stop rendering the button once data is decrypted.
