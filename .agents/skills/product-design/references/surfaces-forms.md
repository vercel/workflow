# Surfaces — Forms

Form-control copy: input labels, helper text, validation messages, aria-label rules, checkboxes, toggles, settings rows.

> **Editing this surface?** Start at [`SKILL.md` → Workflow](../SKILL.md#workflow), then load the matching entry in [`surfaces.md`](surfaces.md).

## Contents

- [Form Controls (Inputs, Selects, Comboboxes, SearchInputs)](#form-controls-inputs-selects-comboboxes-searchinputs)
  - [Required and Optional Fields](#required-and-optional-fields-rulemark-optional-fields)
  - [Country Selector Codes](#country-selector-codes-rulecountry-selector-codes)
  - [Intent and Composer Inputs](#intent-and-composer-inputs)
  - [Helper Text (Description / Hint)](#helper-text-description--hint)
  - [Validation Messages](#validation-messages)
  - [`aria-label`](#aria-label)
  - [Self-Describing Triggers](#self-describing-triggers-ruletrigger-state-as-description)
  - [Co-Location & Adjacent Controls](#co-location--adjacent-controls-rulecolocate-by-mental-model)
- [Checkboxes](#checkboxes)
- [Settings & Toggles](#settings--toggles)
  - [Progressive Disclosure of Dependent Controls](#progressive-disclosure-of-dependent-controls-ruleprogressive-disclosure)

---

## Form Controls (Inputs, Selects, Comboboxes, SearchInputs)

Applies to every Geist form control: `<Input>`, `<Select>`, `<Combobox>`, `<SearchInput>`, `<Textarea>`, `<RadioGroup>`.

**Configuration-field labels.** Title Case noun phrases above the input. **1–6 words.** Not instructions (`Enter your project name` ❌). Free-form intent and composer inputs use the exception below.

### Required and Optional Fields (`rule/mark-optional-fields`)

First ask whether the field belongs in the form. Do not make low-value data collection acceptable by labeling it optional.

When most fields are required, leave required labels unmarked and append the exact text ` (Optional)` to every optional field's visible label. Put ` (Optional)` in the `<legend>` for an optional radio or checkbox group. Always use this spelling, capitalization, parentheses, and position; do not substitute `Optional`, `[Optional]`, `Not required`, or a badge. This makes the exception scannable without repeating `Required` across the form.

If optional fields are the majority, mark the required fields instead and explain the convention once before the form. When the marker is an asterisk, render `*` next to the label in `text-red-900`, make it `aria-hidden`, and use the native `required` attribute so assistive technology receives the same state. `red-800` is a high-contrast background token, not the canonical semantic text color. Use the minority status as the marker; do not mix required and optional markers in one form.

- Keep the status in the persistent label or legend so it remains visible after input and is announced with the control. Never put it only in a placeholder, helper, tooltip, or color. A visual asterisk must be explained before its first use and must not be the only programmatic indication.
- Keep ` (Optional)` in the label's normal typography and text color. The parentheses and exact word are the cue; do not reduce contrast or turn field status into a decorative badge.
- Render markers through a shared label helper within the form or product area instead of hand-styling each field.
- Match behavior and semantics to the label. Required controls use the native `required` attribute; optional controls must submit successfully when empty. If conditional logic changes whether a field is required, update the visible status and programmatic state together.
- Do not add ` (Optional)` to filters, search inputs, standalone toggles, opt-in checkboxes, or other controls whose affordance already makes omission a valid choice. For radio and checkbox groups, add it only when the group collects form data and skipping the whole group may be mistaken for an error.

| ❌ Bad                                                             | ✅ Good                                                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `Company` with no indication that it can be skipped                | `Company (Optional)`                                                                          |
| `Company` with placeholder `Optional`                              | Label `Company (Optional)` + example placeholder `Acme Inc.`                                  |
| `Email` + `*` in `text-red-800`, with no explanation               | `Email` + an explained, `aria-hidden` `*` in `text-red-900`, with native `required` semantics |
| `Company Optional` · `Company [optional]` · placeholder `Optional` | `Company (Optional)` in the persistent label                                                  |
| Every label says `Required`, while one says `Optional`             | Required labels unmarked; only `Company (Optional)` carries status                            |

```tsx
// Required is the minority: explain the marker once before the form.
<p>Required fields are marked with an asterisk (*).</p>
<Input
  id="email"
  label={
    <>
      Email{' '}
      <span aria-hidden className="text-red-900">
        *
      </span>
    </>
  }
  required
/>

// Required is the default: mark only the optional exception.
<Input id="company" label="Company (Optional)" placeholder="Acme Inc." />
```

**Prefer a fuller label over a label + paraphrased helper** ([`rule/label-over-paraphrased-helper`](rules.md)). The 4–6 word zone is good when stretching the label lets you cut a helper that just rewords it. Compare:

| ❌ Short label + paraphrased helper                                                                  | ✅ Fuller label, no helper                                                                       |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Label `Custom Prefix` + helper `Prepended to the environment variables created for this Blob Store.` | Label `Custom Environment Variable Prefix` (suffix `_READ_WRITE_TOKEN` already shows the result) |
| Label `Limit` + helper `Maximum number of concurrent builds.`                                        | Label `Maximum Concurrent Builds`                                                                |
| Label `Threshold` + helper `Monthly spend amount in USD before alerts fire.`                         | Label `Monthly Spend Alert Threshold`                                                            |

Soft cap is 6 words, not a hard limit. Past that, the label starts reading as a sentence — fold the long bit into helper text instead. The anti-pattern is **labels-as-instructions** (`Enter your project name`, `Choose a domain`), not label length.

**Geist API rules.**

- `<Input>` with a string `label` **requires `id`** (the type union is `InputPropsWithStringLabelAndId`). Without an `id`, the `<Label>` wrapper has no `htmlFor` target and screen readers lose the association.
- `<Select>` accepts `label` directly.
- `<Combobox>` does **not** accept a `label` prop. It’s a compound component (`<Combobox.Input>`, `<Combobox.List>`, `<Combobox.Option>`). Provide the visible label via a sibling `<Label htmlFor>` linked to the root via `id`, or via `aria-label` on the root `<Combobox>`. (The root accepts `aria-label` only — there is no `aria-labelledby` prop.) Use `placeholder` for the inline hint.

```tsx
<Input label="Project Name" id="project-name" />
<Select label="Framework" id="framework" />
<Combobox aria-label="Environment Variable Name" placeholder="DATABASE_URL">
  <Combobox.Input />
  <Combobox.List>
    <Combobox.Option value="DATABASE_URL">DATABASE_URL</Combobox.Option>
    <Combobox.Option value="API_KEY">API_KEY</Combobox.Option>
  </Combobox.List>
</Combobox>
```

**Placeholders.** Don’t repeat the label. Example value for free-form inputs, prompt action for selects.

| Component                             | ✅ Placeholder       | ❌ Placeholder                       |
| ------------------------------------- | -------------------- | ------------------------------------ |
| `Input` (`Project Name`)              | `my-awesome-project` | `Enter your project name`            |
| `Input` (`Domain`)                    | `example.com`        | `Enter your domain`                  |
| `Input` (`Environment Variable Name`) | `DATABASE_URL`       | `Name`                               |
| `Select` (`Framework`)                | `Select a framework` | `Choose one…` · `Pick` · `Framework` |
| `Combobox` (`Region`)                 | `Search regions`     | `Select` · `Region`                  |
| `SearchInput` (projects list)         | `Search projects`    | `Search…` · `Filter`                 |

**Select / Combobox options:** Title Case when short. Match canonical branding (`Next.js`, not `NextJS`). Same register across the list. Group with native `<optgroup>` past ~10 items. Geist `<Select>` has no `.Group` static.

**SearchInput placeholder** names the scope (`Search projects`), never bare `Search…`.

### Country Selector Codes (`rule/country-selector-codes`)

In country selectors for rules, queries, or configuration, pair the name with its uppercase two-letter code: `Cuba` followed by `CU` in `text-gray-900`. Right-align codes in dropdown rows; keep them adjacent to names in selected values. Use the same text size and regular weight, without parentheses or a badge. Use `Cuba (CU)` for plain-text labels.

- Show both in options and selected values; include both in search and accessible names.
- Let long option names wrap. Truncate selected names before codes, keeping codes from shrinking.
- Preserve existing names and supported codes, including `XK`; store the code, not the display label.

### Intent and Composer Inputs

An open-ended assistant composer or intent control that elicits a narrative outcome is not a discrete configuration field. Its visible label may be a concise sentence-case question that asks for the desired outcome (`What should this workflow do?`). Do not ask users to describe internal implementation or repeat instructions already visible in the interface.

Use the placeholder for one concrete, appropriately specific example. Name the generated artifact in the action (`Generate Setup`, `Draft Instructions`) without implying it is final. Assistant-proposed output must remain reviewable; user-adjustable proposed fields remain editable, while derived or policy-controlled fields may be read-only when the reason is clear.

### Helper Text (Description / Hint)

Geist has no first-party `<Description>` for form helpers (the `description` package is a `dl`-based definition list, not a field hint). Render as a sibling element with `aria-describedby` linking it to the field. Sentence case, period, one sentence, sits below the field; validation errors replace it on failure. Audience match: developer settings can use technical terms (`Bearer token sent in the Authorization header.`); consumer-facing translates (`A token to prove you’re signed in.`).

```tsx
<Input label="Project Name" id="project-name" aria-describedby="project-name-hint" />
<p id="project-name-hint" className="text-copy-13 text-gray-900">Lowercase letters, numbers, and dashes. Used in deployment URLs.</p>
```

#### Helpers Add — They Don’t Paraphrase

Every form control already conveys information through its **intrinsic affordances**: label, placeholder, prefix/suffix, current value, options, multi-select trigger output, error state. Helper text adds what those _cannot_ show ([`rule/helper-adds-not-paraphrases`](rules.md)). If the helper can be recovered from any visible affordance, cut it — or fold its information into a fuller label ([`rule/label-over-paraphrased-helper`](rules.md)).

**Diagnostic.** Cover the helper with your finger. Can the user still tell what the control does from the label + visible state? If yes, the helper is paraphrasing.

**By control type — what the affordances already convey, and what helper text is still for:**

| Control                               | Already conveyed by intrinsic affordance                                                                                                                     | Helper is for                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `<Input>` text                        | Label · placeholder (format example) · prefix / suffix (resulting form, e.g. `BLOB` + `_READ_WRITE_TOKEN`) · current value                                   | Format constraint not in placeholder (`Must use HTTPS.`) · side-effect (`Overrides Git provider value.`) |
| `<Select>` / `<Combobox>`             | Label · placeholder · selected value · option text inside the dropdown                                                                                       | Scope of options · cross-control implication                                                             |
| Multi-select / popover trigger        | Trigger output is a real-time description (`Production, Preview` · `All Environments` · `No Environments`) ([`rule/trigger-state-as-description`](rules.md)) | Format/limit not visible in the trigger (`Up to 5 regions.`)                                             |
| `<RadioGroup>` / `<Checkbox>` (group) | Legend label · all option labels visible at once                                                                                                             | When mutual exclusivity isn’t obvious · plan/permission gating per option                                |
| `<Toggle>` / `<Switch>`               | Label · ON/OFF position visible                                                                                                                              | One-line consequence of ON ([Settings & Toggles](#settings--toggles)) — never describe OFF               |
| `<Textarea>`                          | Label · placeholder · current value                                                                                                                          | Same as Input                                                                                            |
| `<DatePicker>`                        | Label · placeholder (format) · current value (formatted)                                                                                                     | Range or time-zone qualifier the picker can’t show                                                       |
| `<OTPInput>`                          | `aria-label` IS the description (icon-only / no-visible-text)                                                                                                | Almost never; pair with the email/phone in the `aria-label` itself                                       |

**Legitimate uses for helper text** (kept in spite of the above):

1. **Format constraint not in the placeholder.** `URL` with placeholder `https://api.example.com` + helper `Must use HTTPS.` — the protocol restriction isn’t visible in the example.
2. **Side-effect of the value.** `Build Command` + helper `Overrides the value from your Git provider.` — the input doesn’t show the override.
3. **Plan / permission gating.** `Trusted IPs` + helper `Available on the Enterprise plan.`
4. **Time-scope qualifier.** `Default Region` + helper `Applies to deployments after the next push.`
5. **Cross-control implication.** `Sensitive` toggle on the Custom Prefix block + helper `Permanently hides values after saving.` — names what saving does, not what the toggle is.

**Anti-pattern (most common).** Helper paraphrases what the user can already see:

| ❌ Bad                                                                                                                                  | ✅ Good                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Project Name` + helper `Enter the name of your project.`                                                                               | `Project Name` (no helper)                                                   |
| `Domain` placeholder `example.com` + helper `Provide your domain.`                                                                      | `Domain` placeholder `example.com` (no helper)                               |
| Input with suffix `_READ_WRITE_TOKEN` + helper `This is appended to your environment variable.`                                         | Label `Custom Environment Variable Prefix` (suffix already shows the result) |
| Multi-select trigger `Production, Preview` + helper `Production and Preview will get the value.`                                        | Multi-select alone (trigger IS the description)                              |
| Checkbox group `Notifications` with `Email me on deploy fail` / `Email me on weekly summary` + helper `Choose which emails to receive.` | Group + options alone (legend + options are the description)                 |

### Validation Messages

Name the field and constraint. Sentence case, period at end. Pass a string to `Input`’s `error` prop.

> 🚫 **`please` is banned in inline-field validation.** Validation is conversational; `please` is padding. (`please` is allowed only in incident banners — app at fault — and explicit favor-asks.) `Please enter a valid email` → `Enter a valid email.`

| ✅                                                             | ❌                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------- |
| `Project name is required.`                                    | `You must enter a project name.`                         |
| `Code must be 6 digits.`                                       | `You must enter a valid code with exactly 6 characters.` |
| `Domain must be a valid hostname. Underscores aren’t allowed.` | `Invalid domain.`                                        |
| `Select at least one region.`                                  | `Region selection is required.`                          |
| `Enter a valid email.`                                         | `Please enter a valid email.`                            |

**Name the exact failure when known.** If you can compute the failure mode (length, character set, format), name it. Generic fallback (`Invalid {field}.`) only when you can’t compute the cause; never as a default.

For `Combobox`/`Select` with no results: `No {items} match "{query}"`, not `No results`.

#### Submit Availability and Error Disclosure

Do not disable the primary action solely because one or more fields are invalid when the disabled state would hide what must be fixed. Keep it available so submission can reveal and focus specific inline errors while preserving input.

Disable for pending or duplicate work, or for a prerequisite that cannot be resolved in the form. Make that blocker and its resolution visible rather than relying on disabled-button discovery.

**Validation never gets a stable ID.** Validation is user-state (the user typed a wrong thing); there is no platform-side ID to surface. Same for permission denials. See [`patterns.md` → Stable Identifiers](patterns.md#stable-identifiers).

#### Typed-Confirmation Mismatch

When a destructive modal gates submit on a typed phrase, the mismatch error must name the noun the user is typing — never component-internal terms like `"phrase"` or `"value"`. Follow [Modals → Type-to-Confirm Gates](surfaces-modals.md#type-to-confirm-gates) and render the message under the prompt. Don’t put the prompt in an `<Input>` `label`; `<Label>` title cases the phrase the user must type.

| Prompt                                                           | ✅ Mismatch error                      | ❌                                              |
| ---------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------- |
| `To confirm, type the project name "my-project"`                 | `The project name must match exactly.` | `Phrase must match exactly.` · `Invalid input.` |
| `To confirm, type the API key name "ci-deploy-key"`              | `The API key name must match exactly.` | `Doesn’t look right.`                           |
| `To confirm, type "disable vercel authentication"` (no resource) | `Doesn’t match.`                       | `Phrase must match exactly.` (leaks "phrase")   |

For entity deletes, prefer typing the **resource name verbatim** (`my-project`) over the verb phrase (`delete my-project`). Typing the resource name is the canonical signal that the user knows which thing they're acting on. See [Modal → Destructive Actions](surfaces-modals.md#destructive-actions) for the full pattern.

### `aria-label`

`aria-label` is for icon-only / no-visible-text elements (icon-only button, OTP input). When a button or link already has visible text, don’t duplicate it in `aria-label`. Active voice, lead with action, name the thing. Geist has no `IconButton`. Icon-only buttons use `<Button shape="circle" svgOnly aria-label="…">` (validator throws without both props).

```tsx
// Good
<OTPInput aria-label={`Verification code sent to ${email}`} />
<Button shape="circle" svgOnly aria-label="Copy deployment URL"><IconCopy size={16} /></Button>

// Bad
<Button shape="circle" svgOnly aria-label="Copy"><IconCopy size={16} /></Button>  // copy what?
<Button aria-label="Delete project">Delete Project</Button>  // duplicates visible text
```

### Self-Describing Triggers (`rule/trigger-state-as-description`)

Some controls describe themselves through their visible state in real time. Helper text underneath that paraphrases the control’s own output is filler.

**The trigger output is the description.** A multi-select popover that shows `Production, Preview` (or `All Environments` / `No Environments`) is already telling the user what’s selected. So is a `<Combobox>` that displays the selected project’s name, a `<Select>` showing the chosen framework, an `<Input>` with a live suffix (`BLOB` + `_READ_WRITE_TOKEN`), or a checkbox group whose options are all visible.

Pattern checklist for a self-describing control:

- The control’s visible state names the user’s current choice (or names what the control is for, if no choice has been made).
- The label above names the field.
- A static helper underneath would either restate the label or restate the trigger’s output.

When all three hold, drop the helper. If the helper carries information the trigger can’t — a format limit, a plan gate, a side-effect — keep it; that’s a [legitimate use](#helpers-add--they-dont-paraphrase).

```tsx
// ❌ Helper paraphrases the trigger
<Label value="Environments" />
<EnvironmentMultiSelect /* trigger renders "Production, Preview" */ />
<p className="text-copy-13 text-gray-900">
  Production and Preview will get this value.
</p>

// ✅ Trigger output is the description
<Label value="Environments" />
<EnvironmentMultiSelect />

// ✅ Helper still keeps a non-paraphrased fact
<Label value="Regions" />
<RegionMultiSelect />
<p className="text-copy-13 text-gray-900">Up to 5 regions per project.</p>
```

The rule generalises beyond multi-selects. Anywhere the visible state of the control matches what a helper would say, the helper is paraphrasing — cut it.

### Co-Location & Adjacent Controls (`rule/colocate-by-mental-model`)

Group controls by **what the user is configuring**, not by what category the control belongs to. When two controls jointly configure one mental model, place them adjacent — and the copy on each must not re-explain the other.

Concrete example from the resource-connection modal: the `Custom Environment Variable Prefix` input and the `Sensitive` toggle both control _what env vars get created and how they’re stored_. They live in the same block. The `Environments` multi-select controls _where the resource is available_ — a separate concern, separate block. Once they’re grouped, the helper text rule does extra work: don’t describe the prefix in a way that re-explains the sensitivity toggle next to it, or vice versa.

| Concern                                            | Goes near…                                                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Information architecture / layout / spacing rhythm | The token table in [`packages/web-shared/AGENTS.md`](../../../../packages/web-shared/AGENTS.md) and adjacent shipped layout. |
| Copy implications of co-location                   | Here. Once two controls are co-located, helper text on either must not re-explain the other; jointly the controls form one description.       |

If you find yourself writing a helper that mentions an adjacent control by name, the copy isn’t the problem — the layout is. Run the design-system pass. See [Product Design Workflow](../SKILL.md#workflow).

## Checkboxes

`<Checkbox>` represents inclusion or exclusion of an independent choice within a form, list, or filter, including opt-ins and acknowledgments. Use a group for multi-selection. For a standalone, immediately applied persistent boolean setting, use `<Toggle>` — see [Settings & Toggles](#settings--toggles).

- **Label:** Title Case noun phrase when in a table column header or filter group label. Sentence case full sentence for an acknowledgment (`I agree to the Terms of Service.`).
- **Acknowledgment label takes a period.** It’s a sentence.
- **Group label** above a checkbox group is Title Case (`Notifications`, `Required Permissions`).
- **Indeterminate** state names a partial selection (`3 of 5 selected`); don’t leave the indeterminate state un-labeled.

```tsx
// Multi-select row
<Checkbox checked={selected.has(row.id)} onChange={(c) => toggle(row.id, c)} aria-label={`Select ${row.name}`} />

// Acknowledgment
<Checkbox checked={agreed} onChange={setAgreed}>
  I agree to the <Link href="/terms">Terms of Service</Link>.
</Checkbox>

// Group
<fieldset>
  <legend className="text-label-14">Notifications</legend>
  <Checkbox>Email me when a deployment fails</Checkbox>
  <Checkbox>Email me on weekly usage summary</Checkbox>
</fieldset>
```

## Settings & Toggles

Setting labels follow one rule: **describe what happens when ON**. OFF is implicit.

- **Label:** Title Case noun or noun phrase. 1-4 words.
- **Description (optional):** One sentence about ON. Skip if label is self-evident. Don’t describe OFF; it’s the negation.

**Component API:**

- **`<Toggle>`**: boolean on/off. `checked` is required. Label is `children`, not a `label` prop.
- **`<Switch>` + `<Switch.Control>`**: segmented selector (2-3 mutually exclusive options). Option label lives on `Switch.Control`. Do not use `<Switch>` for boolean on/off.

```tsx
// Boolean (label as children)
<Toggle checked={value} onChange={setValue}>Password Protection</Toggle>
<p className="text-copy-13 text-gray-900">Require a password to view preview deployments.</p>

// Segmented
<Switch name="view">
  <Switch.Control label="Source" value="source" defaultChecked />
  <Switch.Control label="Output" value="output" />
</Switch>
```

| Bad                                                                       | Good                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Label: `Enable password protection`                                       | `Password Protection` (labels are nouns)                               |
| `When enabled, require a password. When disabled, no password is needed.` | `Require a password to view preview deployments.`                      |
| `Toggle to enable/disable the feature`                                    | (delete; toggle conveys the mechanic)                                  |
| `label` / `description` props on `<Switch>`                               | `<Toggle>` for booleans, or `<Switch.Control label="…">` for segmented |

### State-Revealing Labels (`rule/toggle-stable-label`)

A toggle’s job is to encode state by position. When its only or primary **label** also encodes state — `IP addresses are currently {hidden|visible} in the Vercel Dashboard.` — the user has to read the label and reconcile it with the toggle position. Worse, you ship a state-machine of strings: 2 settings × 2 states × (heading + description) = 8 strings to maintain.

Stable labels and stable descriptions cut that to 4. The label names the setting; the description names the consequence of ON; the toggle position is the state.

Visible `Enabled` / `Disabled` status is allowed in the narrow adjacent-title pattern below. That status does not replace the control’s stable accessible name.

```tsx
// ❌ State-revealing label + state-dependent description
<span className="text-heading-14">
  IP addresses are currently {hideIp ? 'hidden' : 'visible'} in the Vercel Dashboard.
</span>
<span className="text-copy-14">
  {hideIp
    ? 'Enabling this setting will show IP addresses in the Vercel Dashboard. After enabling, IP addresses may appear in Firewall data, Observability and in Monitoring queries'
    : 'Disabling this setting will hide IP addresses the Vercel Dashboard. After disabling, IP addresses will no longer appear in Firewall data, Observability and in Monitoring queries.'}
</span>

// ✅ Stable label + stable description
<span className="text-heading-14">Show in Vercel Dashboard</span>
<span className="text-copy-14">
  When on, IP addresses appear in Firewall data, Observability, and Monitoring queries.
</span>
```

The state-machine of strings is a hidden cost: every translator pays for it, every reviewer pays for it, and the bug surface is 4× the simpler form (the typo `hide IP addresses the Vercel Dashboard` shipped because nobody re-read the disable branch).

#### Half-Sentence Labels

A label like `Enabled for` paired with a sibling scope selector is state-revealing too. The text encodes the toggle’s state — and forces the user to read the toggle position, then the partial label, then the selector to assemble one sentence. Make the label a stable noun phrase that names the affirmative aspect; let the scope selector stand alone.

```tsx
// ❌ Half-sentence label that depends on a sibling for grammar
<Toggle checked={on}>
  <p>{on ? 'Enabled for' : 'Disabled'}</p>
</Toggle>;
{
  on ? <DeploymentTypeSelector /> : null;
}

// ✅ Stable label + standalone scope control
<Toggle checked={on}>
  <p>Require Log In</p>
</Toggle>;
{
  on ? <DeploymentTypeSelector /> : null;
}
```

#### Single-Toggle Fieldsets

When a fieldset hosts a single toggle that controls the whole feature, the toggle’s label should name the **affirmative aspect** of the feature, not duplicate the section title. The section title names the feature; the toggle label names what ON does. Prefer parallel verb+noun construction across related toggles.

| Fieldset (section)    | Toggle label             | Why                                                                         |
| --------------------- | ------------------------ | --------------------------------------------------------------------------- |
| Remote Caching        | `Remote Cache`           | section names feature; toggle names the ON-state effect                     |
| Vercel Authentication | `Require Log In`         | affirmative verb-noun; ON = visitor must log in                             |
| Password Protection   | `Require Password`       | parallel with Log In; ON = visitor must enter password                      |
| Trusted IPs           | `Require Trusted IP`     | parallel; ON = visitor must be on trusted IP (singular: per-request)        |
| OPTIONS Allowlist     | `Allow OPTIONS Requests` | inverse polarity — feature creates an exception. Match the actual mechanic. |

Avoid using the feature name as both section title and toggle label — reads as duplication.

#### Adjacent Title With Visible Status

When a persistent adjacent title already names the exact setting, a compact toggle may show `Enabled` / `Disabled` as visible status instead of repeating the title or inventing a weaker affirmative label. This is an exception for the visible status, not the accessible name.

Use this pattern only when:

- the title and toggle are in the same setting row and the title remains visible in both states
- the title unambiguously names the exact setting
- `Enabled` / `Disabled` is standalone status, not half of a sentence completed by another control
- the toggle retains a stable accessible name through an explicit association or screen-reader-only text

Do not let `Enabled` / `Disabled` become the control’s only accessible name. Do not duplicate the full setting title beside the switch solely to satisfy the stable-label rule.

```tsx
<div>
  <p>Auto-assign Custom Production Domains</p>
  <Toggle checked={checked} onChange={setChecked}>
    <span className="sr-only">Auto-assign Custom Production Domains</span>
    <span aria-hidden="true">{checked ? 'Enabled' : 'Disabled'}</span>
  </Toggle>
</div>
```

This exception does not permit state-dependent descriptions or labels such as `Enabled for`, `Currently enabled`, or `IP addresses are currently visible`. Those still create copy branches or require users to assemble meaning across controls.

### Progressive Disclosure of Dependent Controls (`rule/progressive-disclosure`)

When a toggle gates a setting, render dependent controls only when the toggle is ON. Do not leave inputs, selectors, scope pickers, IP/CIDR lists, secret fields, or helper widgets visible-but-disabled when their values have no effect.

```tsx
<Toggle checked={protectionEnabled} onChange={setProtectionEnabled}>
  Require Password
</Toggle>;
{
  protectionEnabled ? (
    <Input label="Password" placeholder="Enter password" value={passwordText} />
  ) : null;
}
```

Keep the toggle, section title, learn-more links, and persistent read-only summaries visible. If an old value helps the user decide whether to re-enable the setting, show it as text, not as a disabled control. Apply the same rule recursively for mode selectors inside the fieldset. Adjacent shipped example: `Require Log In` hides `DeploymentTypeSelector` and `ExceptionsInfo` while OFF (`apps/vercel-site/app/(dashboard)/[teamSlug]/[project]/(project)/settings/deployment-protection/_components/vercel-auth.tsx`).

### No-Negation Toggles (`rule/no-negation-toggles`)

Frame the on-position as the affirmative action. `Show IP addresses` (toggle on = show), never `Hide IP addresses` (toggle on = hide). A negative label paired with a toggle creates a double-negative when the user wants the on-state to be the absence of the action.

| Bad                             | Good                           |
| ------------------------------- | ------------------------------ |
| `Hide IP Addresses` (on = hide) | `Show IP Addresses`            |
| `Disable Notifications`         | `Notifications` or `Notify Me` |
| `Don’t Allow External Sharing`  | `Allow External Sharing`       |

If the underlying state variable is negated (`hideIpAddresses: boolean`), invert at the render boundary (`checked={!hideIpAddresses}`); don’t bend the label to match the variable name.
