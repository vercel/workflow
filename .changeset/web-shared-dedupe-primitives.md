---
'@workflow/web-shared': patch
'@workflow/web': patch
---

Consolidate duplicated UI primitives in the observability UI. `LoadMoreButton`, `DecryptButton` and `MenuDropdown` are now built on the shared `Button` instead of injecting their own CSS, and every decrypt control uses `DecryptButton`, with the unavailable reason in a tooltip. The "Decrypted" state is gone: `decrypted` is deprecated and renders nothing, so hosts should stop rendering the button once data is decrypted. `MenuDropdown` and `ResolveHookModal` use Radix primitives, so they get keyboard navigation, focus trapping and focus return. The copy button, the "Data expired" notice and the event date helpers each have one implementation. Unused `Alert`, `Card` and `DuplicateEventTooltip` components are removed.
