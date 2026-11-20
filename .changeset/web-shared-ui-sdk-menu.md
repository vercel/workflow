---
'@workflow/web-shared': minor
'@workflow/web': patch
---

Add `Menu`, `MenuTrigger`, `MenuContent`, `MenuItem`, `MenuItemIcon` and `MenuSeparator`, built on UI SDK (`@ui-sdk/react`), and move the observability UI's run and hook action menus to them from Radix DropdownMenu. `ResolveHookDropdownItem`'s `DropdownMenuItem` prop is now optional: leave it out inside the new `Menu`. `TooltipContent` gains `portal`, to turn off for tooltips inside a menu.
