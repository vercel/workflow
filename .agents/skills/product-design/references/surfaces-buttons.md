# Surfaces — Buttons, Badges & Headings

Button/badge/heading copy rules. Verb+Noun on action buttons; Title Case on label-style buttons; sentence case on sentence-style buttons; canonical status terms on badges.

> **Editing this surface?** Start at [`SKILL.md` → Workflow](../SKILL.md#workflow), then load the matching entry in [`surfaces.md`](surfaces.md).

## Headings & Page Titles

Verb-forward or task-named. Tell the user where they are or what they’re about to do. Never use the feature name alone.

| ✅                            | ❌                     | Why                   |
| ----------------------------- | ---------------------- | --------------------- |
| `Check Your Email`            | `Verification`         | Verb + concrete noun  |
| `Connect Your GitHub Account` | `Connect Your Account` | Name the provider     |
| `Deploy Your Project`         | `Deployment`           | Action, not label     |
| `Two-Factor Authentication`   | `2FA` / `Verification` | Spelled out, specific |

Title Case.

An optional page description should lead with the attainable outcome, capability, or consequence—not instructions already visible in the form. `Create a project you can deploy from Git.` beats `Use the form below to configure a new project.` Do not narrow the product promise to examples, channels, or integrations unless the contract guarantees them. Omit the description when it adds no new information.

## Buttons & CTAs

Default to a short action label: `{Verb}` or `{Verb} + {Noun}`. Use Title Case for these label-style buttons. Buttons with icons stay on one line.

Label the next user-visible result, not the internal implementation or container:

- `New Chat` creates a new chat. If the action opens or resumes an existing active chat, use `Open Chat`, `Resume Chat`, or the destination name.
- `Copy Page` is ambiguous when a page can mean route, content, file, or published page. Name the object: `Copy URL`, `Duplicate Page`, `Copy Page Content`, or `Create Draft`.
- `Add to Project` is usually too broad. Name the thing being added: `Add Domain`, `Add Environment Variable`, `Add Store`, `Attach Template`.
- Prompt suggestions should lead with an action, not a question, when the system is offering a confident next step. `Review deployment settings` beats `Want to review deployment settings?`.

Use a sentence-style button only when the button is an explicit acknowledgment or attestation: `I understand the risk`, `I’ve copied the recovery code`, `I’ve saved this key`. Sentence-style buttons use sentence case and no period. If the sentence only means "close this modal," use a terse action instead: `Done`.

Default `<Button>` (no `variant`) is primary. Valid `variant` values (Geist `WithTypeTypes` minus the unsupported subset): `default | secondary | tertiary | warning | error | alert`. There is no `variant="primary"`, `variant="success"`, `variant="lite"`, `variant="ghost"`, or `variant="violet"` on Button.

`variant` is the visual type; the HTML `<button type="…">` attribute is `typeName` on Geist Button. `type` is a separate chrome prop (`shadow | invert | unstyled`), not a visual variant. For form submits use `<Button typeName="submit">`, not `<Button type="submit">` (the latter fails type-checking).

### Multiple CTAs

When a surface presents CTAs with distinct visual hierarchy, order them by prominence. In a vertical stack, place the primary CTA first, then secondary, then tertiary. In a horizontal row, place tertiary on the left, then secondary, with primary on the right.

| Layout  | ✅ Good                                      | ❌ Bad                                       |
| ------- | -------------------------------------------- | -------------------------------------------- |
| Stacked | Primary above Secondary above Tertiary       | Tertiary above Secondary above Primary       |
| Row     | Tertiary left, then Secondary, Primary right | Primary left, then Secondary, Tertiary right |

```tsx
// Good
<Button>Deploy Project</Button>
<Button variant="error">Delete All Blobs</Button>
<Button variant="tertiary">Use a Different Email</Button>
<Button>Done</Button>
<Button>I understand the risk</Button>

// Bad
<Button>Submit</Button>               // names nothing
<Button>Confirm</Button>              // confirm what?
<Button variant="error">OK</Button>   // generic on destructive
<Button type="tertiary">Remove</Button> // wrong prop — `type` is not the visual variant, use `variant`
<Link>← Back</Link>                   // undescriptive
<Button>I’ve Saved This Key</Button>  // sentence forced into Title Case
```

**Mode-switch buttons** name the outcome and add `instead`: `Use an Authenticator App Instead`, `Use a Passkey Instead`, `Use a Recovery Code Instead`.

## Split Buttons

Use a split button only when one action is the clear default and the alternatives are meaningfully secondary. The primary click target must perform the obvious default action, and its visible label must name exactly what clicking it does. Put alternate, less common, or lower-confidence actions in the menu.

Do not use an umbrella label when the primary area performs a specific sub-action. If the primary click copies Markdown, label it `Copy Markdown` or move that action into the menu; do not label the primary action `Add to Project`. If no action is a defensible default, use a menu or explicit buttons instead of a split button.

| Primary behavior | Good primary label | Good menu alternatives                 | Bad primary label |
| ---------------- | ------------------ | -------------------------------------- | ----------------- |
| Copy Markdown    | `Copy Markdown`    | `Copy Plain Text`, `Download Markdown` | `Add to Project`  |

## Badge

Status, plan tier, environment, or role. The most widely-used copy-bearing component after Button.

- **One word when possible, two max.** `Active` / `Pending` / `Failed` / `Trial` / `Pro` / `Production`.
- **Title Case.** `Enterprise Trial`.
- **Match the canonical API/log term.** `Deployed`, not `Live`.
- **`title` prop is the accessible name** for icon-only / ambiguous badges. Active voice, lead with what the badge represents.

Lifecycle badges (Alpha/Beta/GA): see [mechanics.md → Beta / Preview / Experimental badges](mechanics.md#beta--preview--experimental-badges).

```tsx
// Good
<Badge variant="blue">Production</Badge>
<Badge variant="amber">Trial</Badge>
<Badge variant="red">Failed</Badge>
<Badge variant="gray">Archived</Badge>
<Badge variant="blue-subtle" title="On Pro plan">Pro</Badge>

// Bad
<Badge>You are on the Pro plan</Badge>          // too long
<Badge>✓ Success</Badge>                         // variant conveys state
<Badge>Currently Active</Badge>                  // redundant
<Badge>Live</Badge>                              // non-canonical — use "Production" or "Deployed"
```

### Canonical Status Terms

Match the API enum. When Vercel adds new states, update the owning constants/types source first, then this table. Generated OpenAPI files are read-only evidence, not the place to make the change; verify the authoritative source for the specific domain.

| Domain (enum field)         | Good                                                                                      | Don’t use                                         |
| --------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Deployment (`readyState`)   | `Ready`, `Building`, `Error`, `Queued`, `Canceled`                                        | `Live`, `Done`, `Failed Deploy`, `Cancelled`      |
| Team member (`role`)        | `Owner`, `Member`, `Viewer`, `Billing`                                                    | `Admin` (unless that’s the canonical role)        |
| Env scope (`target`)        | `Production`, `Preview`, `Development`                                                    | `Prod`, `Dev`, `Staging` (unless Staging is real) |
| Webhook delivery (`status`) | `Delivered`, `Failed`, `Retrying`, `Skipped`                                              | `Sent`, `OK`, `Errored`                           |
| Cron job (`status`)         | `Active`, `Disabled`, `Failing`                                                           | `Running`, `Off`, `Broken`                        |
| Certificate (`status`)      | `Pending`, `Issued`, `Renewing`, `Failed`, `Expired`                                      | `Provisioning`, `Active`, `Dead`                  |
| Workflow run (`status`)     | `Running`, `Paused`, `Sleeping`, `Awaiting Signal`, `Failed`, `Compensating`, `Cancelled` | `Working`, `Idle`, `Stuck`                        |
| Queue message (`status`)    | `Pending`, `Processing`, `Delivered`, `Failed`, `Dead-Letter`                             | `Waiting`, `Sent`, `Lost`                         |
| Sandbox (`status`)          | `Running`, `Stopped`, `Expired`, `Terminated`                                             | `Live`, `Off`, `Killed`                           |

Spelling matches the API enum. Vercel uses `Canceled`, not `Cancelled`. Workflow’s `Cancelled` is one of the few intentional exceptions; mirror the enum.
