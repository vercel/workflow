---
"@workflow/web-shared": patch
---

Fix `Button` hover, focus, and corner radius to match Geist. The dark-mode hover no longer relies on an unregistered Tailwind variant (it previously turned the inverted button's background dark/transparent depending on the consumer), the focus-visible ring is now rendered, and the `xs` size uses Geist's 4px tiny radius. Styles are written to work under both Tailwind v3 and v4.
