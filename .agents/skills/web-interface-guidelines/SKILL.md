---
name: web-interface-guidelines
description: Web Interface Guidelines for building accessible, fast, and delightful UIs. Use when building UI or layouts, implementing interactions, forms, animations, or ensuring accessibility. Triggers on tasks involving user interfaces, form handling, keyboard navigation, focus management, touch interactions, or performance optimization.
---

# Web Interface Guidelines

Rules for building accessible, fast, delightful UIs. Use MUST/SHOULD/NEVER to guide decisions.

## Quick Reference

### Critical Requirements (MUST)

**Keyboard & Focus**

- Full keyboard support per [WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/patterns/)
- Visible focus rings (`:focus-visible`; group with `:focus-within`)
- Manage focus (trap, move, return) per APG patterns

**Touch & Targets**

- Hit target ≥24px (mobile ≥44px); expand hit area if visual <24px
- Mobile `<input>` font-size ≥16px to prevent zoom
- `touch-action: manipulation` to prevent double-tap zoom

**Forms**

- Hydration-safe inputs (no lost focus/value)
- Enter submits text input; ⌘/Ctrl+Enter submits textarea
- Errors inline next to fields; focus first error on submit
- Warn on unsaved changes before navigation

**Navigation & State**

- URL reflects state (deep-link filters/tabs/pagination)
- Back/Forward restores scroll
- Links use `<a>/<Link>` for proper navigation (Cmd/Ctrl/middle-click)

**Accessibility**

- `<title>` matches current context
- Icon-only buttons have descriptive `aria-label`
- Prefer native semantics (`button`, `a`, `label`) before ARIA
- Redundant status cues (not color-only)

### Animation Rules

- Honor `prefers-reduced-motion`
- Animate compositor-friendly props (`transform`, `opacity`) only
- Animations must be interruptible and input-driven
- Correct `transform-origin`

### Performance Targets

- Mutations (`POST/PATCH/DELETE`) target <500 ms
- Virtualize large lists
- Prevent CLS from images (explicit dimensions)
- Track and minimize re-renders

## References

- **Complete Guidelines**: See [references/guidelines.md](references/guidelines.md) for full MUST/SHOULD/NEVER rules
- **Colour and typography tokens**: See [`packages/web-shared/AGENTS.md`](../../../packages/web-shared/AGENTS.md) for the Geist tokens the observability UI uses
