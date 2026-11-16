---
'@workflow/web': patch
---

Fix the connection status tooltip in the header so env values are readable. It now inherits the shared Geist tooltip's colors and type instead of light-surface `text-foreground` / `text-muted-foreground` classes (which rendered dark-on-dark), and the key/value grid uses a valid Tailwind v4 column template so keys and values sit side by side.
