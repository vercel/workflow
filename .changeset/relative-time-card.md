---
'@workflow/web-shared': minor
---

Add a RelativeTimeCard hover card backed by a shared ContextCard provider, giving timestamp tooltips animated, collision-aware morphing transitions. Absolute run/activity timestamps (Created, Started, Completed, etc.) now render in vercel/front's format (e.g. `JUN 10 10:16:02.69 GMT-4`). Register the Geist `dark-theme`/`light-theme` Tailwind variants in `styles.css` so the context-card arrow tip uses the card's border color in dark mode instead of rendering as a white caret. Add a transparent hover bridge across the `sideOffset` gap between the trigger and the card so moving the cursor onto the card no longer flickers.
