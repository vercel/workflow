# Observability UI styling rules

These rules apply to `packages/web-shared` and `packages/web` (which consumes it).

## Design tokens come from geistcn

The block between `geistcn:begin` and `geistcn:end` in `src/styles.css` is a 1:1 copy of geistcn's tokens in `vercel/front`. Don't edit it by hand: run `pnpm --filter @workflow/web-shared sync-geist-tokens <absolute-path-to-vercel-front>` to regenerate it. Don't redeclare Geist tokens anywhere else, including for `prefers-color-scheme`; the tokens flip with the theme class, so don't add `dark:` overrides for colours that already do.

## Never use opacity to set a text colour

Text colour always comes from a Geist token or the surface's inherited foreground. Don't make text lighter by fading it:

- no `opacity-*` on an element to mute its text (`<span className="opacity-60">`)
- no text-colour alpha modifiers (`text-muted-foreground/70`, `text-foreground/50`)
- no inline or CSS `color` with alpha (`rgba(…, 0.8)`)

A faded text colour depends on whatever is underneath it, so it becomes unreadable on another surface: the inverted tooltip pill, dark mode, or a coloured row. Geist tokens are defined for both themes.

Opacity is fine for anything else, such as disabled controls, overlays, fades and animations, or dimming a whole row.

### Follow the dashboard's patterns

Use the same tokens as the dashboard in `vercel/front` (`apps/vercel-site`):

| Need | Use |
| --- | --- |
| Primary text | `text-gray-1000` (or inherit) |
| Secondary text, labels | `text-gray-900`, e.g. `text-gray-900 text-label-13` for a field label |
| Tertiary text, hints, metadata, muted icons | `text-gray-700` |
| Muted text that brightens on hover | `text-gray-900 hover:text-gray-1000` |
| Status text | the `-800` step of the scale: `text-red-800`, `text-amber-800`, `text-green-800` |
| Text on an inverted surface (tooltip, selection bar) | inherit the surface's foreground. Don't add `text-foreground` / `text-muted-foreground`, which are meant for the light surface |

Content inside the shared `Tooltip` renders on a `gray-1000` pill with `background-100` text. Use the standard single tooltip: plain content in one colour, with no colour or text-size overrides.
