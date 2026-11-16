# Surface Routing

Load [`copy.md`](copy.md) for all user-facing language, then load only the references matching the current surface or domain. Load [`interface-quality.md`](interface-quality.md) for full-surface work or structural changes.

## Surface References

| Surface                                                           | Load                                                                   | Internal pass                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| Full UI review or structural UI change                            | `product-judgment.md` + `interface-quality.md` + matching rows below   | product, component, design-system, interaction, resilience |
| Modal or `ResourceDeletionModal`                                  | `surfaces-modals.md` + `patterns.md` destructive patterns + `verbs.md` | component + design-system + interaction                    |
| Drawer, Sheet, Dialog, or Popover                                 | `surfaces-modals.md`                                                   | component + interaction + responsive                       |
| Toast, Note, Banner, Tooltip, or EmptyState                       | `surfaces-feedback.md` + relevant `patterns.md`                        | component + design-system                                  |
| Button, Badge, page/section heading                               | `surfaces-buttons.md`                                                  | component + design-system + focus                          |
| Input, Select, Combobox, RadioGroup, Textarea, helper, validation | `surfaces-forms.md`                                                    | component + interaction + resilience                       |
| Choicebox, rich choice card, or recommendation                    | `surfaces-forms.md` + `product-judgment.md` + local components       | product + component + interaction                          |
| Checkbox, Toggle, Switch                                          | `surfaces-forms.md`                                                    | component + interaction                                    |
| Assisted authoring, generated setup, or alternate manual path     | `product-judgment.md` + `surfaces-forms.md` + `resilience.md`          | product + state + interaction                              |
| Table or data collection                                          | `surfaces-data.md`                                                     | design-system + responsive + resilience                    |
| Link, ButtonLink, external icon, tabs, breadcrumbs, or navigation | `surfaces-navigation.md`                                               | destination + component + keyboard + URL state             |
| Card, Avatar, Gauge, StatusDot, RelativeTimeCard, Kbd, Feedback   | `surfaces-data.md`                                                     | component + design-system                                  |
| Code, InlineCode, CodeBlock, Snippet                              | `surfaces-data.md` + `mechanics.md`                                    | design-system                                              |
| Skeleton, Spinner, Progress, route loading                        | `surfaces-feedback.md` + `patterns.md` async states                    | state + design-system                                      |
| Error or not-found page                                           | `surfaces-errors.md` + `patterns.md`                                   | state + design-system                                      |
| Destructive or undo flow                                          | `surfaces-modals.md` + `patterns.md` + `verbs.md`                      | product consequence + component                            |
| Permission, plan, policy, or cross-tenant gate                    | `patterns.md` + `surfaces-errors.md`                                   | product consequence + state                                |
| Notification/activity/audit feed                                  | `surfaces-lifecycle.md` + `surfaces-navigation.md` + `mechanics.md`    | hierarchy + state                                          |
| Workflow, Sandbox, Queue, build/deploy progress                   | `surfaces-lifecycle.md` + `patterns.md`                                | state + resilience                                         |
| Auth, OTP, passkey, Sign Up/Log In/Log Out                        | `surfaces-lifecycle.md` + `verbs.md` + `glossary.md`                   | component + interaction                                    |

## Domain References

| Domain                                                             | Load                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------ |
| Incident and planned maintenance                                   | `patterns.md` incident section                         |
| Dates, times, units, shortcuts, lifecycle labels, audit logs, cron | `mechanics.md`                                         |
| Product names and capitalization                                   | `glossary.md`                                          |
| Verb choice                                                        | `verbs.md`                                             |
| Bad/good copy catalog                                              | `anti-patterns.md`                                     |
| Rule citation lookup                                               | `rules.md`                                             |

## Code Patterns to Scan

Find likely user-facing language:

```bash
rg -n '(aria-label|placeholder|title=|subtitle=|description=|label=|submitButtonText|errorNoteMessage|toasts\.(success|error|warning|message)|<Modal\.Title|<Modal\.P|<Note |<Banner |<EmptyState|<Tooltip|throw new Error\()' path/to/file.tsx
```

Find likely structural/interface work:

```bash
rg -n '(className=|text-\[|gap-\[|bg-\[#|<button|<select|<textarea|<div[^>]+onClick|window\.confirm|role=|tabIndex|autoFocus|aria-live|loading=|disabled=|<Switch|<Toggle|<Modal|<Drawer|<Menu|<Combobox)' path/to/file.tsx
```

These searches identify inspection targets; they do not prove a violation.
