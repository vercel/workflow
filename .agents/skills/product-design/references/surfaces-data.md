# Surfaces — Data Display

Data-presentation copy: table column headers, card titles, avatar fallbacks, gauges, status dots, code blocks, time displays, keyboard shortcuts, feedback widgets.

> **Editing this surface?** Start at [`SKILL.md` → Workflow](../SKILL.md#workflow), then load the matching entry in [`surfaces.md`](surfaces.md).

## Contents

- [`<Table>`](#table)
- [`<Card>`](#card)
- [`<Avatar>`](#avatar)
- [`<Gauge>` & `<StatusDot>`](#gauge--statusdot)
- [Code Display (`Code`, `InlineCode`, `CodeBlock`, `Snippet`)](#code-display-code-inlinecode-codeblock-snippet)
- [`<RelativeTimeCard>`](#relativetimecard)
- [`<Kbd>`](#kbd)
- [`<Feedback>`](#feedback)

---

## `<Table>`

Data tables. Columns are scannable; copy is dense; headers identify, cells display.

- **Column headers** (`<Table.Head>`): Title Case nouns or noun phrases. `Last Used`, `Requests (7d)`, `Created`, `Status`. Never sentences.
- **Sortable column indicator:** column header doubles as a button; visible text stays Title Case. The sort-direction arrow is decorative.
- **Cell formatting:** dates, numbers, sizes. See [mechanics.md → Dates and Times](mechanics.md#dates-and-times) and [mechanics.md → Units and SI Prefixes](mechanics.md#units-and-si-prefixes).
- **Empty cell:** `—` (em-dash literal) for an unknown or missing value. Never `N/A` or `null`.
- **Empty table:** if no rows, render `<EmptyState>` outside the table (No-results variant for filtered states, Blank Slate for never-created). Don’t leave an empty `<Table.Body>`.
- **Pagination labels:** `Previous` / `Next` (Title Case). Page-count copy: `Page 2 of 7` or `21–40 of 142`.

```tsx
<Table>
  <Table.Header>
    <Table.Row>
      <Table.Head>Name</Table.Head>
      <Table.Head>Last Used</Table.Head>
      <Table.Head>Requests (7d)</Table.Head>
      <Table.Head>Created</Table.Head>
    </Table.Row>
  </Table.Header>
  <Table.Body>
    <Table.Row>
      <Table.Cell>prod-api</Table.Cell>
      <Table.Cell>2 minutes ago</Table.Cell>
      <Table.Cell className="tabular-nums">12,430</Table.Cell>
      <Table.Cell>Mar 14, 2026</Table.Cell>
    </Table.Row>
  </Table.Body>
</Table>
```

When the underlying list is empty (filter cleared, never populated), render `<EmptyState.Root>` instead of `<Table>` rather than an empty `<Table.Body>`.

## `<Card>`

Layout container. Card itself has no copy slots — its props are visual only (`border`, `shadow`, `hoverable`). All copy lives in children. Treat each card as a mini-section: lead with a label or heading, follow with body copy, end with one primary action when appropriate.

- Heading inside a card: `text-label-16` Title Case. Don’t use `<h1>`.
- Body inside a card: sentence case, `text-copy-14`.
- Action inside a card: a single primary `<Button>` with a Verb + Noun label. Avoid stacking three CTAs.
- Empty card variant: use `<EmptyState>` instead — don’t hand-roll empty copy in a card.

```tsx
// Good
<Card border className="p-6 gap-3">
  <span className="text-label-16">Production Deployment</span>
  <p className="text-copy-14 text-gray-900">Deployed 3 minutes ago from <code>main</code>.</p>
  <Button variant="secondary">View Deployment</Button>
</Card>

// Bad: three competing CTAs, no clear lead
<Card border className="p-6">
  <Button>Deploy</Button><Button>Edit</Button><Button>Delete</Button>
</Card>
```

## `<Avatar>`

User/team identifier. Copy lives in `title` (rendered to `aria-label` / image `title`), `letter` (initials shown when no image), and `placeholder` (renders generic copy `"Placeholder Avatar"`).

- `title`: the actual entity name, not a role (`Acme Inc.`, `Jane Doe`). Don’t prepend `Avatar of` — Geist already does that for letter avatars (`Avatar with initials: JD`).
- `letter`: 1-2 chars, derived from the entity. Uppercase. Don’t use emoji.
- `placeholder`: only when the entity is genuinely unknown (loading shell). For permanent unknowns, set a real `letter`.

```tsx
// Good
<Avatar title={user.name} letter={initials(user.name)} src={user.avatar} size={24} />
<Avatar title="Acme Inc." letter="A" size={24} />
<Avatar placeholder size={24} />               // loading

// Bad
<Avatar title="User Avatar" letter="?" size={24} />        // generic + bad fallback
<Avatar title="Avatar of Jane Doe" letter="JD" size={24} />// duplicates "Avatar of"
```

## `<Gauge>` & `<StatusDot>`

Numeric/status indicators. Both expose minimal copy — supplement with adjacent labels.

**`<Gauge>`** displays a value 0-100. `showValue` renders the number inside; `children` overlays a custom node (typically an icon). Copy guidance:

- Always pair with an adjacent label or `<Tooltip>` saying what the value represents (`Build Cache Hit Rate`).
- The number itself isn’t a sentence; never include a unit inside `children` (use the label).
- For `indeterminate`, show explanatory copy nearby (`Calculating usage…`).

**`<StatusDot>`** renders a colored dot. **Scope: deployment lifecycle only.** Its `state` prop accepts `QUEUED | BUILDING | READY | ERROR | CANCELED | DELETED` (matching the deployment readyState enum). The component composes its own `aria-label` (`{titlePrefix} is building.`).

- `titlePrefix`: noun phrase only. Default is `"This deployment"`. Use the entity (`titlePrefix="my-app production"`). Don’t end with a verb.
- `label`: pass when the dot stands alone without surrounding text — Geist sentence-cases the state.

For non-deployment statuses (Workflow runs, Queue messages, Sandbox, Cron jobs), don’t use `<StatusDot>` — use a `<Badge>` with the canonical state vocabulary from the [Canonical Status Terms](surfaces-buttons.md#canonical-status-terms) table. The state names in that table are product vocabulary (Title Case in UI); the StatusDot enum is a separate component-level constant for deployments only.

```tsx
<Gauge value={uptime} size="medium" showValue />
<span className="text-label-14">Uptime</span>

<StatusDot state="BUILDING" titlePrefix="Production deployment" label />
```

## Code Display (`Code`, `InlineCode`, `CodeBlock`, `Snippet`)

Code surfaces have no Title Case rule — preserve user-supplied syntax verbatim. Copy review focuses on placeholder, prompt, and any prose around the block.

- `<InlineCode>` children: literal token. Wrap identifiers, env var names, branch names, file paths (`process.env.VERCEL_URL`). Don’t use for emphasis (`<InlineCode>important</InlineCode>` is wrong — use prose or a `<Badge>`).
- `<Code>`: `children` are syntax-highlighted source. Don’t paraphrase — keep real, runnable code. The `syntax` prop is **required** and names the language (`bash`, `tsx`, `json`, etc.).
- `<CodeBlock>`: same content rules as `<Code>`. Provide a language hint for highlighting.
- `<Snippet>`: `text` is the copy-to-clipboard payload (string or array of lines). `placeholder` is sentence case, no period (`Generate a token to get started`). `prompt` defaults to `true` and renders `$` for shell — turn off only for non-shell snippets.
- `copyText`: only when `text` contains rich nodes; the user copies plain text.

**Authors never type `$`.** The component renders the prompt; passing `text="$ vercel deploy"` results in `$ $ vercel deploy`. See [`mechanics.md` → Code in Copy](mechanics.md#code-in-copy) for the same rule from the formatting side.

```tsx
// Good
<p>Set <InlineCode>process.env.DATABASE_URL</InlineCode> in production.</p>
<Snippet text="vercel deploy --prod" />
<Snippet text={['vercel link', 'vercel pull']} />
<Snippet text="" placeholder="Run vercel link to fetch env vars" prompt={false} />
<Code syntax="bash">vercel deploy --prod</Code>

// Bad — copy issues only
<InlineCode>important</InlineCode>              // emphasis, not code
<Snippet text="$ vercel deploy --prod" />       // double $ — component already renders the prompt
<Snippet text="vercel deploy --prod." />        // trailing period in a shell command
<Snippet text="" placeholder="Placeholder." />  // ends with a period
```

> **Component-API note (not a copy issue):** `<Code>vercel deploy --prod</Code>` fails type-check because `syntax` is required. Always pass `<Code syntax="bash">…</Code>` (or `tsx`, `json`, etc.). Listed here separately so copy reviewers don’t score this as a copy bug.

## `<RelativeTimeCard>`

Displays relative time (`5m ago`, `Yesterday`) with a hover card showing absolute timestamps. Copy comes from `date` (a number — don’t format it yourself) and optional `children` overriding the default short label.

- Don’t pass a pre-formatted string as `children` unless you need a non-time label (`Just now`, `Pending`). The component’s `useShortTimeAgo` is the canonical short form.
- Tooltip/card is auto-generated with UTC + local timezone. Don’t replicate that copy elsewhere on the row.
- Pair with a leading label only when context is ambiguous (`Last deploy: <RelativeTimeCard date={ts} />`). Don’t append `ago` again — the formatter already does.

```tsx
// Good
<RelativeTimeCard date={deploy.createdAt} />
<span>Last deploy <RelativeTimeCard date={deploy.createdAt} /></span>

// Bad
<RelativeTimeCard date={ts}>{format(ts, 'PP')}</RelativeTimeCard> // bypasses canonical format
<span><RelativeTimeCard date={ts} /> ago</span>                    // duplicates "ago"
```

## `<Kbd>`

Keyboard shortcut display. Modifiers come from boolean props (`meta`, `shift`, `alt`, `ctrl`); the literal key goes in `children`. The component handles platform symbols (`⌘` on macOS, `Ctrl` elsewhere), so don’t hard-code them.

- `children`: a single uppercase letter, digit, or named key (`K`, `7`, `Enter`, `Esc`). Don’t lowercase.
- Don’t spell out modifiers in `children` (`<Kbd>Cmd+K</Kbd>` — wrong; use `<Kbd meta>K</Kbd>`).
- In prose, surround with verbs in sentence case: `Press <Kbd meta>K</Kbd> to open the command menu.` Period inside the sentence, never inside the `<Kbd>`.

```tsx
// Good
<Kbd meta>K</Kbd>
<Kbd shift meta>P</Kbd>
<span>Press <Kbd meta shift>K</Kbd> to clear the cache.</span>

// Bad
<Kbd>cmd+k</Kbd>                             // hard-coded modifier + lowercase
<Kbd>Press K</Kbd>                           // sentence inside <Kbd>
```

## `<Feedback>`

In-product feedback widget (emoji + textarea). Copy slots are `label` (the trigger button) and `copy` (override of the **prompt header** that sits next to the emoji row — NOT the textarea placeholder, which is hard-coded `Your feedback...` and not configurable).

- `label`: Title Case, short. Default is `Feedback`. Override only when scoping to a flow (`Feedback on Imports`, `Report a Bug`).
- `copy`: overrides the prompt header (default is `Was this helpful?`). Sentence case, ends with a question or short prompt; appears next to the emoji selector. Default copy already exists — only override when the surface needs specificity.
- The textarea placeholder (`Your feedback...`) is fixed by Geist; you cannot override it via this component.
- Don’t end the trigger label with `?` — the emoji selector already invites response.

```tsx
// Good
<Feedback label="Feedback" />
<Feedback label="Feedback on Imports" copy="How did the import go?" />
// Renders header "How did the import go?" next to the emoji picker;
// the textarea below still says "Your feedback...".

// Bad
<Feedback label="give feedback" copy="Please share your thoughts" /> // not Title Case label; `please` banned in `copy`
```
