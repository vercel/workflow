---
'@workflow/web-shared': patch
'@workflow/web': patch
---

Match the Geist design tokens 1:1 with geistcn: `styles.css` now carries geistcn's palette, shadows, focus ring, z-index, motion and popover tokens plus its `hocus` variant, and `dark:` follows the theme class. The theme no longer applies under `[data-theme="dark"]`, and the `dark-theme:`/`light-theme:` variants no longer match `.dark`/`.light`; use `dark:` instead.
