---
name: web-guidelines
description: Rules that must be followed when working on the workflow observability UI in packages/web and packages/web-shared. Before opening a PR that modifies files in either package, read this skill and make sure you are not introducing new violations.
---

`packages/web` is the standalone observability app (`workflow web`). `packages/web-shared` holds the trace viewer, event list, stream viewer, and sidebar panels, which also render inside the Vercel dashboard. Follow all of these guidelines when working in either package. This file is an index of more detailed guides. If a section is relevant to your task, read the linked guide.

Before finalizing a review or implementation, inspect the rendering tree of the surface you changed, including shared wrappers, data hooks, and reachable dialogs. Identify the patterns present, then read every applicable guide below. Repeat this selection when newly inspected code reveals another pattern.

| Task or code involves                                                                                 | Required guides                                                                 |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Existing guideline violations, `BROKEN-WINDOWS.md` records, or UI debt                                | [Broken Windows](./broken-windows/GUIDE.md)                                     |
| Skeletons, loading indicators, list fallbacks, or data that arrives after first render                | [Loading States](./loading-states/GUIDE.md)                                     |
| Sheets, alert dialogs, or modals, including their dynamic content, scrolling, sizing, or footer actions | [Dialogs](./dialogs/GUIDE.md)                                                   |
| Hover text, hints, or a `title` attribute                                                             | [Tooltips](./tooltips/GUIDE.md)                                                 |
| Text colour, typography, or other Geist tokens                                                        | [`packages/web-shared/AGENTS.md`](../../../packages/web-shared/AGENTS.md)       |
| Any change to code in either package, including logic, styles, layout, and loading states             | [Validation](./validation/GUIDE.md)                                             |

## Guide Structure

Each topic guide starts with **When to Use** and **Required Patterns**. Supporting material follows where the guide covers it: **Rationale**, **Examples**, and **Related Guidance**.

Only explicitly documented exceptions are permitted. A guide with no listed exceptions allows none.

## Broken Windows

New code must follow all of the guidelines. Existing code that violates them is recorded in a co-located `BROKEN-WINDOWS.md` file.

[Guide](./broken-windows/GUIDE.md)

## Loading States

Every region that waits for data shows a skeleton with the geometry of its settled content. The only acceptable CLS is 0.

[Guide](./loading-states/GUIDE.md)

## Dialogs

Choose between a Sheet and a modal by how stable and how large the content is.

[Guide](./dialogs/GUIDE.md)

## Tooltips

Never use the HTML `title` attribute as a tooltip. Hover text is always the shared `Tooltip` component.

[Guide](./tooltips/GUIDE.md)

## Validation

Check every change before calling it done. Add unit tests for logic, not for constants or types. Render visual changes.

[Guide](./validation/GUIDE.md)
