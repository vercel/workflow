# Dialogs

## When to Use

Use when choosing or implementing Sheets, alert dialogs, or modals in `packages/web` or `packages/web-shared`.

## Required Patterns

Follow the logic of this pseudocode when choosing a dialog:

```
if the content has an unstable size (e.g. loading state and unpredictable settled height, multi-step form where each step has a different height, dynamic lists that change height):
  use a `<Sheet>`
elif the content takes up a lot of space:
  use a `<Sheet>`
else:
  use a modal (`<AlertDialog>` for confirmations)
```

### Sheets

Use `Sheet` from `packages/web/app/components/ui/sheet.tsx` and open it from the right (`side="right"`).

If the Sheet has actions, render them at the bottom of the Sheet, outside its scrollable region.

### Modals

Use `AlertDialog` from `packages/web/app/components/ui/alert-dialog.tsx` for confirmations, as the run actions in `run-detail-view.tsx` do. Name the action in the confirm button and the title, and keep the cancel button as `Cancel`. For deletes, use `This cannot be undone.` for the irreversibility note and give the confirm button the destructive treatment.

Dialogs in `packages/web-shared` (such as `ResolveHookModal`) cannot import from `packages/web`. Build them on `Modal` from `packages/web-shared/src/components/ui/modal.tsx`.

## Rationale

Sheets are larger than modals, leaving more room for large UI without scrolling. Modals are vertically centred, so unpredictable content height shifts their position. Sheets are sized relative to the viewport and stay stable as their content changes.
