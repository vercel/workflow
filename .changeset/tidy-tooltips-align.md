---
'@workflow/web-shared': patch
'@workflow/web': patch
---

Use a single Geist tooltip everywhere in the observability UI. `@workflow/web-shared` now exports `Tooltip`, `TooltipTrigger`, `TooltipContent`, and `TooltipProvider`, and `@workflow/web` consumes them instead of its own shadcn copy, so every tooltip matches the one used by the trace detail panel's "Navigate up"/"Navigate down" controls.
