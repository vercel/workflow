---
'@workflow/web-shared': patch
'@workflow/web': patch
---

Tidy styles and copy in the observability UI. Inline colour styles in the error card, error stack block and conversation tabs are now token classes. Arbitrary pixel font sizes and off-scale grays use the type scale and the documented gray steps. The conversation/JSON tabs move keyboard focus with the arrow keys and show a focus ring. The error card exposes its expanded state, and the trace shortcut helper's dismiss button no longer depends on host-only colour tokens. Error and empty-state copy follows the dashboard conventions.
