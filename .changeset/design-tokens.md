---
'@workflow/web-shared': patch
'@workflow/web': patch
---

Align the design tokens with the Vercel dashboard: `styles.css` now carries the full palette, shadows, focus ring, z-index, motion and popover tokens plus a `hocus` variant, and `dark:` follows the theme class. The theme no longer applies under `[data-theme="dark"]`, and the `dark-theme:`/`light-theme:` variants no longer match `.dark`/`.light`; use `dark:` instead.
