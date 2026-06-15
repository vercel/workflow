---
'@workflow/web-shared': patch
---

Make the context card arrow tip stroke use the theme-aware `--ds-gray-alpha-400` token so it matches the card border in both light and dark themes (previously hardcoded grays that relied on a `dark-theme` variant).
