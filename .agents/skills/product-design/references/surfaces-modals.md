# Surfaces — Modals & Destructive Actions

Modal, Drawer, and destructive-action copy. Verb+Noun primary buttons, type-to-confirm prompts, severity ladder for non-delete destructive actions.

> **Editing this surface?** Start at [`SKILL.md` → Workflow](../SKILL.md#workflow), then load the matching entry in [`surfaces.md`](surfaces.md).

## Contents

- [Destructive Actions](#destructive-actions)
- [`<Modal>` (`geist/components`)](#modal-geistcomponents)
- [`<Drawer>` (`geist/components`)](#drawer-geistcomponents)

---

## Destructive Actions

Red button. **Format: `Verb + Noun`** (`Delete Project`, `Remove Team Member`, `Empty Blob`, `Revoke Token`, `Rotate Key`). Never generic (`Confirm`, `OK`) or bare-verb (`Delete`, `Revoke`). Voice rules in [patterns.md → Destructive copy patterns](patterns.md#destructive-copy-patterns).

**Default keyboard focus on Cancel.** Never on the destructive button. Enter must not trigger destructive action without typed confirmation. Destructive actions require explicit affirmative selection.

**Modal body never trails with `Do you want to continue?`** The action button names the verb; the body names the consequence. A trailing confirmation question is filler the user must read past to find the actionable button. Same applies to `Are you sure?`, `Confirm to continue.`, `Click Continue to proceed.` — all redundant when the primary button is a clear `Verb + Noun`.

```tsx
// ❌ Trailing confirmation question
<Modal.Subtitle>
  Removing this configuration disables Single Sign-On for this team.
</Modal.Subtitle>
<Modal.Subtitle>Do you want to continue?</Modal.Subtitle>
{/* ... */}
<Modal.Action>Continue</Modal.Action>

// ✅ Consequence + irreversibility + named action
<Modal.Subtitle>
  Removing this configuration disables Single Sign-On for this team. This cannot be undone.
</Modal.Subtitle>
{/* ... */}
<Modal.Action>Remove SAML</Modal.Action>
```

**High-stakes destructive actions affecting production traffic require typed confirmation** — not deletes only. Token rotation, key revocation, plan downgrade, transfer-out: all should gate the destructive button on typing the resource name.

Pattern: `To confirm, type the {resource type} name "{name}"`

### `DestructiveConfirmationInput` (Canonical Type-to-Confirm)

In the Vercel dashboard, every type-to-confirm gate renders through `DestructiveConfirmationInput`. This repository has no equivalent component: build the gate from local primitives and follow the same props and copy rules below.

**Don’t hand-roll the prompt.** Geist `<Label>` (behind `<Input label>`, `<Select label>`, `<Textarea label>`) applies CSS `capitalize`, so `my-site.com` renders as `Vercel-Site.Com` and users who type what they see fail the exact match. Browser translation and mobile autocorrect rewrite the phrase too. The component renders the phrase verbatim, opts the field out of translation, and turns off autocapitalization, autocorrect, spellcheck, and autocomplete. Don’t rebuild that with `bypassCasing`, `translate="no"`, or an `aria-label`.

```tsx
// ❌ Label title cases the domain; translation and autocorrect can rewrite it
<Input
  id="confirm-domain"
  label={`To confirm, type the domain name “${domain}”`}
  value={confirmText}
  onChange={(e) => setConfirmText(e.target.value)}
/>

// ✅ Renders: To confirm, type the domain name “my-site.com”
<DestructiveConfirmationInput
  error={mismatch ? 'The domain name must match exactly.' : null}
  onChange={(e) => setConfirmText(e.target.value)}
  value={confirmText}
  verificationLabel="domain name"
  verificationPhrase={domain}
/>
```

- `verificationPhrase`: the exact value to type. Prefer the resource name for entity deletes; use a lowercase verb phrase for non-entity actions (`"disable vercel authentication"`).
- `verificationLabel`: the noun from the pattern (`"project name"`, `"team slug"`). Omit it when the phrase needs no noun: `To confirm, type “disable vercel authentication”`.
- `error`: the mismatch message. Copy rules in [Forms → Typed-Confirmation Mismatch](surfaces-forms.md#typed-confirmation-mismatch).
- The component is presentation only. The caller owns the value and the `===` check. It forwards its ref and native input props, so react-hook-form `register` and native `pattern`/`required` work unchanged.

### `ResourceDeletionModal` (Canonical Delete)

A Vercel dashboard component with no equivalent in this repository. Its copy rules below apply to any delete confirmation built here. Require typed confirmation for high-stakes deletes (`type "delete my-project" to confirm`).

**Always pass these explicitly. The component defaults are wrong:**

- `errorNoteMessage`: defaults to `'This action is not reversible. Please be certain.'` (banned phrase). Override with `'This cannot be undone.'`.
- `submitButtonText`: defaults to `'Continue'`. Override with the named action: `'Delete Project'`, `'Delete Blob'`, `'Delete All Blobs'`.
- `submitButtonType="error"`: gives the destructive red treatment.

**Title scope:** disambiguate single vs. all. Single-resource delete → title is `Project` / `Blob`. Bulk delete → title is `All Projects` / `All Blobs`. Don’t lose the scope signal. The scope-ambiguous title is the most-missed pattern in shipped diffs.

**Code-prop values match shipped constants, not prose rules.** `parentResourceType`, `resourceType`, and similar prop strings mirror existing constants (for example `parentResourceType="blob store"` lowercase, even when user-facing prose uses `Blob`). Match adjacent shipped code; do not apply Title Case or canonical-noun rules to prop strings.

```tsx
<ResourceDeletionModal
  active={open}
  onCancel={closeModal}
  onConfirm={performDelete}
  resourceName={project.name}
  resourceType="project"
  title="Project"
  subtitle={
    <p>
      <b>{project.name}</b> and all its deployments will be permanently deleted.
    </p>
  }
  submitButtonText="Delete Project"
  submitButtonType="error"
  errorNoteMessage="This cannot be undone."
/>
```

### Severity Ladder (Non-Delete)

Not deletes. Do not use `ResourceDeletionModal`. Each has its own confirmation shape.

- **Reversible:** revoke token, disconnect Git, remove member (re-addable). Confirm direct effect only. CTAs: `Revoke Token`, `Disconnect GitHub`, `Remove Member`. Always Verb + Noun — bare `Disconnect` is wrong.
- **Irreversible, no delete:** rotate without backup, expire a key. Confirm direct + downstream effect. Body: `All existing sessions will be invalidated.` Close with `This cannot be undone.`
- **With downstream effects:** remove member (tokens go too), downgrade plan (retention shrinks). Enumerate downstream effects as a bullet list.
- **`Verb + Qualifier` (`Disable Anyway`, `Delete Anyway`):** use ONLY when an active warning sits above the button on the same surface (the user is overriding a stated risk). Use bare `Verb` (or `Verb + Noun`) otherwise. Without a stated warning, the qualifier reads as melodrama.

  ✅ Above the button: `Health checks failed for this region. Disabling anyway will route traffic without verification.` → button: `Disable Anyway`.
  🚫 No warning above the button: button is just `Disable` (or `Disable Skew Protection` per Verb + Noun).

```tsx
<Modal.Modal active={open} onClickOutside={close}>
  <Modal.Body>
    <Modal.Header>
      <Modal.Title>Rotate Signing Key</Modal.Title>
    </Modal.Header>
    <div className="p-4">
      <Modal.P>
        A new key will be generated. All existing sessions will be invalidated.
      </Modal.P>
    </div>
    <Modal.Actions>
      <Modal.Action variant="secondary" onClick={close}>
        Cancel
      </Modal.Action>
      <Modal.Action variant="error" onClick={rotate}>
        Rotate Key
      </Modal.Action>
    </Modal.Actions>
  </Modal.Body>
</Modal.Modal>
```

**Compound destructive.** When removing X also affects Y and Z, copy lists the cascades regardless of whether removing X is reversible. Use a bullet list:

```
- {N} API tokens will be revoked
- {N} integrations they own will be disabled
- Their access to {N} projects will be removed
```

Close with the irreversibility clause that matches the headline action, then a `Verb + Noun` button:

- Headline irreversible (delete primary resource): `This cannot be undone.`
- Headline reversible but cascade isn’t (e.g. `Remove Team Member` — the member is re-addable, but their revoked tokens aren’t recoverable): `Some effects cannot be undone.`

Don’t claim full irreversibility when only part of the operation is irreversible. See [`patterns.md` → Destructive Copy Patterns](patterns.md#destructive-copy-patterns) for the full rule.

## `<Modal>` (`geist/components`)

`<Modal.Title>` is Title Case, short. `<Modal.P>` is sentence case, 1-3 sentences. Cancel button: always `Cancel`. Primary button names the action and matches the title verb. Use `<Modal.Action>` for buttons inside `<Modal.Actions>` (matches shipped exemplars).

```tsx
<Modal.Modal active={open} onClickOutside={close}>
  <Modal.Body>
    <Modal.Header>
      <Modal.Title>Transfer Project</Modal.Title>
    </Modal.Header>
    <div className="p-4">
      <Modal.P>
        Transfer <b>{project.name}</b> to another team. The new team will become
        the owner and take over billing.
      </Modal.P>
    </div>
    <Modal.Actions>
      <Modal.Action variant="secondary" onClick={close}>
        Cancel
      </Modal.Action>
      <Modal.Action onClick={transfer}>Transfer Project</Modal.Action>
    </Modal.Actions>
  </Modal.Body>
</Modal.Modal>
```

## `<Drawer>` (`geist/components`)

Lateral sheet for persistent associated context (log details, deployment metadata, member profile). Slides in from the side; the underlying page stays visible.

**Drawer vs. Modal.** Drawer = lateral context, persistent associations, underlying UI stays visible (`View Deployment Details`). Modal = blocking decision, page dimmed (`Delete Deployment`). Modal titles are Title Case statements, not questions — drop the trailing `?`.

**Copy.** Title (`<DrawerTitle>`) Title Case, names the entity. Body is read-mostly: sentence case prose, Title Case sub-headings. Action buttons optional; follow the same `Verb + Noun` rule when present.

```tsx
<Drawer show={open} onDismiss={close}>
  <DrawerTitle>Deployment Details</DrawerTitle>
  <div className="p-4 flex flex-col gap-4">
    <Button variant="secondary" onClick={openLogs}>
      View Logs
    </Button>
  </div>
</Drawer>
```

Don’t use Drawer for confirmation; the lack of a blocking dim is wrong for confirmation copy. Use `<Modal>` instead.
