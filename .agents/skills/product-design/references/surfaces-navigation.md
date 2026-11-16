# Surfaces — Navigation

Nav-related copy: sidebar, tabs, breadcrumbs, pagination, menus, command palette.

> **Editing this surface?** Start at [`SKILL.md` → Workflow](../SKILL.md#workflow), then load the matching entry in [`surfaces.md`](surfaces.md).

## Contents

- [Links & Navigation](#links--navigation)
  - [External links and new tabs](#external-links-and-new-tabs)
- [`<Tabs>` (`geist/components`)](#tabs-geistcomponents)
- [`<Breadcrumbs>` (`geist/components`)](#breadcrumbs-geistcomponents)
- [`<Pagination>` (`geist/components`)](#pagination-geistcomponents)
- [Menus (`Menu`, `DotsMenu`, `ContextMenu`)](#menus-menu-dotsmenu-contextmenu)
- [`<CommandMenu>` (`geist/components`)](#commandmenu-geistcomponents)
- [Sidebar (`Sidebar`, `SidebarLink`, `SidebarSection`)](#sidebar-sidebar-sidebarlink-sidebarsection)

---

## Links & Navigation

Links describe where they go. Never `click here`, never bare `Learn more`.

| ✅                                | ❌                       |
| --------------------------------- | ------------------------ |
| `View the deployment logs`        | `Click here to see logs` |
| `Learn more about edge functions` | `Learn more`             |
| `Delete blobs with the SDK`       | `Click here for SDK`     |

### External links and new tabs

Decide the icon and tab behavior independently.

#### Show the external icon?

1. Is the destination owned and operated by Vercel?
   - **Yes:** do not show the icon. This includes the dashboard, `vercel.com`, Vercel Docs, Vercel Support, Vercel Changelog, and other Vercel-owned properties.
   - **No:** show the icon. It tells the user they are leaving Vercel.
2. If ownership is uncertain, verify it. Do not guess from whether the URL is absolute, cross-origin, or served by another microfrontend.

The icon describes the destination, not whether the browser opens a new tab. Link text must still name the destination.

#### Open a new tab?

1. Open links in the same tab by default.
2. Open a new tab when the user needs to keep their current Vercel work available, such as unsaved configuration, an active task, or a partner handoff they must return from.
3. Never open a new tab solely because a link is external, absolute, cross-origin, cross-microfrontend, non-prefetchable, or expected to load slowly.

| Example                                            | External icon | Tab      |
| -------------------------------------------------- | ------------- | -------- |
| AI Gateway Models on `vercel.com`                  | No            | Same tab |
| Vercel Docs, Support, or Changelog                 | No            | Same tab |
| Stripe documentation                               | Yes           | Same tab |
| Stripe documentation while preserving unsaved work | Yes           | New tab  |
| Vercel Docs while preserving unsaved work          | No            | New tab  |

Downloads, `mailto:`, and `tel:` links describe their action or file type directly; do not use the external icon solely because they leave the page.

**Component behavior:** inspect the installed Geist implementation before choosing props. The current `Link external` API couples the external icon to new-tab behavior, and non-prefetchable URLs may also open in a new tab. If that behavior conflicts with this decision tree, fix or extend the primitive instead of changing the intended navigation.

**Verification:** inspect the rendered icon, actual `target`, accessible name, and Cmd/Ctrl/middle-click behavior. Search the changed path for `external`, `tab`, `target="_blank"`, `IconExternal`, and URL-prefix heuristics. Cite violations as `interface/navigation-boundary`.

This policy keeps the [HTML meaning of “external”](https://html.spec.whatwg.org/multipage/links.html#link-type-external) separate from new-tab behavior.

## `<Tabs>` (`geist/components`)

Tabs switch between sibling views inside a single page. Copy lives in each tab’s `title` (and optional `tooltip`) on the `tabs` array. Title Case, 1-2 words, naming the destination — not a verb.

- `tabs[].title`: Title Case, name the view (`Overview`, `Activity`, `Settings`). Don’t use verbs (`View Logs` belongs on a button).
- `tabs[].tooltip`: optional one-liner explaining a constraint or empty count, sentence case.
- `tabs[].icon`: optional; if present, leading icon must visually align — never two-line a tab.

```tsx
// Good
<Tabs tabs={[
  { value: 'overview', title: 'Overview' },
  { value: 'logs', title: 'Logs' },
  { value: 'settings', title: 'Settings', tooltip: 'Only visible to project owners' },
]} />

// Bad
<Tabs tabs={[
  { value: 'a', title: 'View Overview' },     // verb belongs on a button
  { value: 'b', title: 'logs' },              // not Title Case
  { value: 'c', title: 'Settings & Config' }, // long; pick one noun
]} />
```

Don’t reuse Tabs for navigation between unrelated pages — that’s a sub-menu (see Links & Navigation).

## `<Breadcrumbs>` (`geist/components`)

Trail of `Breadcrumbs.Item` children. Copy lives in each item’s children. Each item names the entity at that level, not the page’s purpose. Title Case for proper nouns and entity types; sentence case is acceptable when the segment is the literal name a user typed (project slug, branch name).

- `Breadcrumbs.Item` children: short noun phrase or proper name (`Acme Inc.`, `my-app`, `Settings`).
- Final item is `active`; don’t append `(current)` or `· here`.
- Truncation is automatic — don’t pre-truncate strings.

```tsx
// Good
<Breadcrumbs>
  <Breadcrumbs.Item>Acme Inc.</Breadcrumbs.Item>
  <Breadcrumbs.Item>my-app</Breadcrumbs.Item>
  <Breadcrumbs.Item active>Settings</Breadcrumbs.Item>
</Breadcrumbs>

// Bad
<Breadcrumbs>
  <Breadcrumbs.Item>Home</Breadcrumbs.Item>          // ambiguous
  <Breadcrumbs.Item>Project Settings Page</Breadcrumbs.Item> // duplicates the next level + adds "Page"
  <Breadcrumbs.Item active>Edit settings →</Breadcrumbs.Item> // verb + arrow
</Breadcrumbs>
```

## `<Pagination>` (`geist/components`)

Previous/next links on docs and long lists. Copy lives in `previous.title` and `next.title` (the destination name); Geist auto-renders the `Previous`/`Next` label and chevrons.

- `previous.title` / `next.title`: Title Case, names the page you’re linking to. No `Page 3` or `Older Posts`.
- Don’t prepend `←` or `Go to` to the title — `aria-label` already does that (`Go to previous page: {title}`).

```tsx
// Good
<Pagination
  previous={{ title: 'Deploy Hooks', href: '/docs/deploy-hooks' }}
  next={{ title: 'Environment Variables', href: '/docs/environment-variables' }}
/>

// Bad
<Pagination
  previous={{ title: '← Previous', href: '/x' }}        // generic; chevron is automatic
  next={{ title: 'Next page (Env Vars)', href: '/y' }}  // duplicates "Next"
/>
```

## Menus (`Menu`, `DotsMenu`, `ContextMenu`)

Action menus rendered from a trigger. Each item child is the visible label.

- Item children: Title Case, `{Verb}` or `{Verb} {Noun}`. Same rules as Buttons & CTAs. Never end with `…` unless the action opens a follow-up dialog (`Rename…`, `Transfer to Team…`).
- Destructive items: red color is set by the component or via `type` — copy still names the target (`Delete Project`, not `Delete`).
- `prefix` icon optional; never replace the label with an icon-only item.
- Section headers (`<MenuSection title>`) are Title Case, ≤ 2 words (`Workspace`, `Recent Projects`).

```tsx
// Good
<DotsMenu>
  <MenuItem onClick={rename}>Rename…</MenuItem>
  <MenuItem onClick={duplicate}>Duplicate Deployment</MenuItem>
  <MenuItem onClick={remove} type="error">Delete Deployment</MenuItem>
</DotsMenu>

// Bad
<DotsMenu>
  <MenuItem>Edit</MenuItem>                  // edit what?
  <MenuItem>delete</MenuItem>                // not Title Case + no object
  <MenuItem>More options →</MenuItem>        // arrow; menus aren’t links
</DotsMenu>
```

`ContextMenu` follows identical rules — its `Item` children are the labels.

## `<CommandMenu>` (`geist/components`)

Spotlight-style search/command palette. `CommandMenu` is a compound component — copy lives on `<CommandMenu.Root>` (page list), `<CommandMenu.Input>` (placeholder), `<CommandMenu.Item>` (children + optional `keybind`), and `<CommandMenu.Group>` (heading).

- `CommandMenuPage.label` (passed via `<CommandMenu.Root pages={…}>`): Title Case, names the scope (`Projects`, `Team Settings`).
- `CommandMenuPage.placeholder`: sentence case, single line, action-oriented (`Search projects…`, `Type a command or search…`).
- `<CommandMenu.Item>` children: Title Case verb phrase. Same rules as button labels (`Deploy Project`, `Invite Team Member`).
- `<CommandMenu.Group>` heading (when used): Title Case, ≤ 2 words.

```tsx
// Good — compound API
<CommandMenu.Root
  open={open}
  setOpen={setOpen}
  pages={[{ label: 'Projects', placeholder: 'Search projects…' }]}
>
  <CommandMenu.Input />
  <CommandMenu.List>
    <CommandMenu.Group heading="Actions">
      <CommandMenu.Item callback={deploy} keybind={['Meta', 'D']}>
        Deploy Project
      </CommandMenu.Item>
      <CommandMenu.Item callback={invite}>Invite Team Member</CommandMenu.Item>
    </CommandMenu.Group>
  </CommandMenu.List>
</CommandMenu.Root>

// Bad
<CommandMenu.Root
  open={open}
  setOpen={setOpen}
  pages={[{ label: 'Projects', placeholder: 'Search…' }]}  // search what?
>
  <CommandMenu.List>
    <CommandMenu.Item callback={deploy}>deploy</CommandMenu.Item>             // not Title Case, no object
    <CommandMenu.Item callback={openProject}>Go to project page</CommandMenu.Item> // navigation, not command
  </CommandMenu.List>
</CommandMenu.Root>
```

## Sidebar (`Sidebar`, `SidebarLink`, `SidebarSection`)

Primary dashboard navigation. The highest-traffic copy in the product — every Vercel page renders it.

- **`<Sidebar>`** is a layout shell (`top`, `className`, `children`). No copy slots directly.
- **`<SidebarLink title="…">`**: the visible nav label. Title Case noun, 1–2 words, names the destination. Match the canonical labels in [`verbs.md` → Navigation Labels](verbs.md#navigation-labels) (`Settings`, `Members`, `Billing`, `Activity`, `Logs`, `Usage`, `Domains`).
- **`<SidebarLink badgeCount={n}>`**: integer badges only, no string. Drop the badge when `n === 0`.
- **`<SidebarSection title="…">`**: section heading inside the sidebar. Title Case, 1–2 words (`Workspace`, `Recent Projects`, `Resources`).

```tsx
// Good
<Sidebar>
  <SidebarSection title="Workspace">
    <SidebarLink href="/projects" title="Projects" />
    <SidebarLink href="/integrations" title="Integrations" badgeCount={2} />
    <SidebarLink href="/usage" title="Usage" />
    <SidebarLink href="/settings" title="Settings" />
  </SidebarSection>
</Sidebar>

// Bad
<SidebarLink href="/projects" title="View Projects" />              // verb belongs on a button
<SidebarLink href="/settings" title="Settings & Configuration" />   // pick one noun
<SidebarLink href="/settings" title="settings" />                   // not Title Case
<SidebarLink href="/projects" title="Projects (3)" />               // use badgeCount, not parens
```

Don’t reuse `<SidebarLink>` for primary CTAs — those go in the page chrome, not in nav.
