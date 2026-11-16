# Verbs

Canonical action verbs across the dashboard. Apply when writing buttons, toasts, modal titles, error CTAs, navigation, and any user-facing action label.

> **Editing this surface?** Start at [`SKILL.md` → Workflow](../SKILL.md#workflow), then load the matching entry in [`surfaces.md`](surfaces.md).

Rule slugs: `rule/destructive-names-action`, `rule/term-consistency`, `rule/title-case`. Decode any slug via [`rules.md`](rules.md).

## Contents

- [Verbs](#verbs)
  - [Contents](#contents)
  - [Destructive Verbs](#destructive-verbs)
  - [Addition Verbs](#addition-verbs)
  - [Modification Verbs](#modification-verbs)
  - [Permission & Access Verbs](#permission--access-verbs)
  - [Auth Verbs (Sign Up, Log In, Log Out)](#auth-verbs-sign-up-log-in-log-out)
  - [Navigation Labels](#navigation-labels)
  - [Cancellation Verbs](#cancellation-verbs)
  - [Confirmation Banned](#confirmation-banned)
  - [Verb + Noun Reference](#verb--noun-reference)

---

## Destructive Verbs

The most-confused destructive verbs each carry distinct semantics. Pick the verb that matches the actual data outcome; the user reads the verb as a promise.

| Verb           | Use for                                                                     | Reversible?                                 | Examples                                                       |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| **Delete**     | Permanent removal of a primary resource and its data                        | No (data loss)                              | `Delete Project`, `Delete Blob`, `Delete API Key`              |
| **Remove**     | Severs an association without destroying data                               | Yes (re-addable)                            | `Remove Team Member`, `Remove Domain`, `Remove from Favorites` |
| **Disconnect** | Severs an integration; data remains at the partner/source                   | Yes (reconnectable)                         | `Disconnect GitHub`, `Disconnect Slack`                        |
| **Revoke**     | Invalidates an auth credential; affected systems start receiving 401        | No for the credential, yes for the resource | `Revoke Token`, `Revoke API Key`, `Revoke Access`              |
| **Empty**      | Drains a container of items but keeps the container                         | Yes (re-fillable)                           | `Empty Blob`, `Empty Cache`                                    |
| **Rotate**     | Issues new credentials and invalidates old ones                             | No for old credentials                      | `Rotate Key`, `Rotate Secret`                                  |
| **Cancel**     | Aborts an in-flight or scheduled operation; doesn’t destroy stored state    | Depends on operation                        | `Cancel Run`, `Cancel Subscription`                            |
| **Stop**       | Halts a running resource; resumable                                         | Yes (resumable)                             | `Stop Sandbox`                                                 |
| **Terminate**  | Halts a running resource permanently; admin-only                            | No                                          | `Terminate Sandbox`                                            |
| **Downgrade**  | Moves a paid resource to a lower tier; downstream limits shrink             | Yes (re-upgradable)                         | `Downgrade to Hobby`                                           |
| **Transfer**   | Moves ownership/control to another team or user; current actor loses access | Yes (re-transferable)                       | `Transfer Ownership`                                           |
| **Leave**      | Removes the current user from a shared resource                             | Yes (re-joinable on re-invite)              | `Leave Team`                                                   |

Don’t conflate: `Delete Member` reads like data loss; use `Remove Member`. The member account isn’t being deleted; only their association with the team.

Don’t soften: `Remove Project` understates the consequence. Projects with deployments and data are permanently destroyed; use `Delete Project`.

**`Delete API Key` vs `Revoke API Key`.** Both ship in the dashboard. Use `Delete` when the key record is removed from Vercel storage entirely (BYOK credentials, ephemeral tokens). Use `Revoke` when the key remains visible in audit history but is invalidated. The AI Gateway BYOK flow uses `Delete {Provider} API Key` because the credential is removed from storage.

When the count is known, **show it**: `Delete 5 Items`, not `Delete Selected`. The exact number names the blast radius; `Selected` hides it.

For typed-confirmation modals, interpolate the resource name verbatim: `Delete my-project` (lowercase preserved).

Past-tense forms for toasts and audit logs match the verb 1:1: `Project deleted`, `Member removed`, `Token revoked`, `GitHub disconnected`, `Cache emptied`, `Key rotated`. Don’t cross-pair (`Project removed` after `Delete Project` is the most common drift bug).

## Addition Verbs

| Verb        | Use for                                               | Examples                                                |
| ----------- | ----------------------------------------------------- | ------------------------------------------------------- |
| **Add**     | Existing thing into a container or list               | `Add Domain`, `Add Member`, `Add Environment Variable`  |
| **Create**  | A new thing that didn’t exist                         | `Create Project`, `Create Deployment`, `Create Token`   |
| **Connect** | Establishes integration with an external system       | `Connect GitHub`, `Connect Account`, `Connect Database` |
| **Import**  | Brings an existing external resource under management | `Import Project`, `Import from Git`                     |
| **Invite**  | Human additions via email or OAuth                    | `Invite Member`, `Invite Collaborator`                  |

Don’t say `Create Domain`; the domain already exists, so use `Add Domain`. Don’t say `Add Project`; the project is a new resource, so use `Create Project`.

For human additions, prefer `Invite Member` over `Add Member from GitHub` whenever an email or OAuth handshake is involved.

Edge cases:

- `Connect Domain` is wrong; domains don’t have a partner relationship. Use `Add Domain`.
- `Create Member` is wrong; members are humans, not new resources. Use `Invite Member`.
- `Add Project` is wrong when scaffolding a fresh project; use `Create Project`. `Add Project` is correct only when adding an existing project to a group or list.

## Modification Verbs

| Verb       | Use for                                                           | Examples                           |
| ---------- | ----------------------------------------------------------------- | ---------------------------------- |
| **Save**   | Persist changes to settings, drafts, or in-progress work          | `Save Changes`, `Save Draft`       |
| **Update** | Replace existing value with a new value (keeps history)           | `Update Plan`, `Update Email`      |
| **Apply**  | Make a configuration take effect                                  | `Apply Changes`, `Apply Filter`    |
| **Edit**   | Open the editing UI (not the action of writing the change itself) | `Edit Project`, `Edit Profile`     |
| **Change** | Replace a selectable option that can’t be edited in place         | `Change Plan`, `Change Region`     |
| **Manage** | High-level entry into multiple sub-actions                        | `Manage Members`, `Manage Billing` |

Don’t say `Update Profile` for first-time edits; `Edit Profile` opens the form. `Update` implies a value already exists and is being replaced.

`Submit` is banned as a generic action. See [Confirmation Banned](#confirmation-banned).

## Permission & Access Verbs

Permission and access copy describes who can do what. Pick the verb by what the copy is granting.

| Verb         | Use for                                                                       | Examples                                                                                  |
| ------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Allow**    | Granting an actor (a user, role, or group) permission to perform an action    | `Allow team members to log in with an identity provider`, `Allow access`, `Allow Members` |
| **Block**    | Inverse of Allow; denies the actor the action                                 | `Block requests from this IP`, `Block external sharing`                                   |
| **Enable**   | Turning on a feature or capability for the team or project (not for an actor) | `Enable Two-Factor Authentication`, `Enable Spend Management`                             |
| **Require**  | Compelling an action as a condition of access                                 | `Require 2FA for all members`, `Require Verified Commits`                                 |
| **Grant**    | Formal language for one-time permission grants (rarely; prefer `Allow`)       | `Grant access to this team`                                                               |
| **Restrict** | Narrowing access to a defined subset                                          | `Restrict access to verified domains`                                                     |

**`Allow` is canonical for actor-permission copy.** Industry-standard across security/access UX (firewall: `Allow this app`, browser: `Allow notifications`, OS: `Allow access`). Don’t soften with `Let team members do X` — `Let` reads casual and obscures the permission semantics. Don’t replace with `Enable team members to do X` — `Enable` is for capabilities (turning on a feature), not for granting permission to actors.

```tsx
// ✅ Permission grant for actors → Allow
<p>Allow team members to log in with an identity provider.</p>

// ✅ Feature capability → Enable
<Toggle>Enable Two-Factor Authentication</Toggle>

// ✅ Conditional access → Require
<Toggle>Require 2FA for all members</Toggle>

// ❌ Casual softener
<p>Let team members log in with an identity provider.</p>

// ❌ Wrong category — Enable is for features, not actors
<p>Enable team members to log in with an identity provider.</p>
```

## Auth Verbs (Sign Up, Log In, Log Out)

Vercel’s canonical auth verbs across the dashboard. Title Case as button/heading labels; sentence case lowercase as verbs in body prose; sentence case past tense in toasts and audit logs.

| Action                           | Button / heading | Body prose | Past tense   | Notes                                 |
| -------------------------------- | ---------------- | ---------- | ------------ | ------------------------------------- |
| Create a new account             | `Sign Up`        | `sign up`  | `Signed up`  | Title Case capitalizes `Up`.          |
| Authenticate to existing account | `Log In`         | `log in`   | `Logged in`  | Both words capitalized in Title Case. |
| End the session                  | `Log Out`        | `log out`  | `Logged out` | Same shape as `Log In`.               |

Don’t mix `Sign In` and `Log In` in the same Vercel-owned flow. Sign-in-with-{partner} buttons preserve the partner’s verb if the destination dictates it (`Sign in with GitHub`).

**Exception:** `Sign in with Vercel` is a sentence-case literal brand name (the OAuth-provider product), not a phrasal-verb auth label. Do NOT rewrite to `Sign In with Vercel`. Same shape as `Sign in with GitHub`. See [glossary.md → Auth & Identity](glossary.md#auth--identity) for the canonical entry.

For component examples, see [surfaces.md → Auth (Sign Up & Log In)](surfaces-lifecycle.md#auth-sign-up--log-in). For migration cases away from `Sign in`, see [anti-patterns.md → Sign Up vs. Log In](anti-patterns.md#sign-up-vs-log-in-canonical).

## Navigation Labels

Single canonical label per concept. Drift between `Settings` / `Preferences` / `Configuration` is the most common source of nav inconsistency; lock to the left column.

| Canonical    | Don’t use                                                                   |
| ------------ | --------------------------------------------------------------------------- |
| **Settings** | Preferences, Configuration, Options, Setup                                  |
| **Members**  | Users, Team, People (when the surface is the list of team members)          |
| **Billing**  | Account, Subscription (when the surface is invoices, payment methods, plan) |
| **Activity** | History, Log (for human-readable activity feed)                             |
| **Logs**     | Console, Output (for raw log streams)                                       |
| **Usage**    | Metrics, Stats (for plan-relative consumption views)                        |
| **Domains**  | URLs, Hosts (for the domain-management surface)                             |

`Settings` is the canonical Vercel label across web and any future surfaces. Don’t drift to `Preferences`, `Configuration`, or `Options`.

## Cancellation Verbs

| Verb             | Use for                                                     | Examples                                       |
| ---------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| **Cancel**       | Abort the current action; pair with a primary action button | `Cancel` (in a modal Actions row)              |
| **Discard**      | Throw away in-progress work without saving                  | `Discard Changes`, `Discard Draft`             |
| **Close**        | Dismiss a non-action surface (info modal, banner, sheet)    | `Close`                                        |
| **Dismiss**      | Same as Close but emphasizes user choice (notifications)    | `Dismiss`                                      |
| **Keep Editing** | Return to the form when the alternative is destructive      | `Keep Editing` (paired with `Discard Changes`) |

Don’t use `Cancel` on a confirmation modal where the alternative is to keep editing; `Keep Editing` is clearer — it names what happens when the user clicks it, where `Cancel` is ambiguous (cancel the edit? cancel the confirmation?).

Don’t use `Close` on a destructive confirmation; `Cancel` is the convention because it implies abandoning the destructive intent.

## Confirmation Banned

These appear on confirmation modals and generic action buttons. All are banned in favor of named actions that summarize the outcome (`rule/destructive-names-action`).

| Banned       | Replace with                                                                                                                                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OK`         | `{Verb + Noun}` (`Save Changes`, `Delete Project`)                                                                                                                                                                                                                                                                           |
| `Submit`     | `{Verb + Noun}` (`Create Account`, `Send Invitation`)                                                                                                                                                                                                                                                                        |
| `Yes`        | `{Verb + Noun}` (`Delete Message`)                                                                                                                                                                                                                                                                                           |
| `No`         | `Cancel` or `Keep Editing`                                                                                                                                                                                                                                                                                                   |
| `Confirm`    | `{Verb + Noun}` (`Confirm Delete` is still banned — write `Delete Project`)                                                                                                                                                                                                                                                  |
| `Click Here` | `{Destination name}` (`Open Settings`, `Read the Docs`)                                                                                                                                                                                                                                                                      |
| `Continue`   | `{Next-step verb}` (`Save and Continue` only when literally chained; otherwise name the action)                                                                                                                                                                                                                              |
| `Done`       | `{Verb + Noun}` or `Close` (when the surface really is informational). `Done` is canonical for informational acknowledgment-only modals. For one-time credential reveals that require attestation, use a sentence-style button such as `I’ve saved this key` — see [copy.md → Canonical Phrases](copy.md#canonical-phrases). |

## Verb + Noun Reference

Destructive CTAs follow `Verb + Noun` (see `rule/destructive-names-action`). The noun names the resource type. Always:

`Delete Project` · `Remove Team Member` · `Revoke API Key` · `Disconnect GitHub` · `Empty Blob` · `Rotate Key` · `Cancel Subscription` · `Cancel Run` · `Stop Sandbox` · `Terminate Sandbox` · `Downgrade to Hobby` · `Transfer Ownership` · `Leave Team` · `Reject Run`

**`Transfer Ownership` is canonical.** Don’t drift to `Transfer Project` or `Transfer Team` (the team isn’t being transferred — its ownership is). Modal title can name the resource (`Transfer Project Ownership`); button stays `Transfer Ownership`.

Workflow / Sandbox / Queues non-destructive CTAs that follow Verb + Noun: `Approve and Resume` · `Resume Run` · `Restart Run` · `Retry Run` · `Replay Message`.

When the noun is interpolated for safety (typed-confirmation modals), the resource name is preserved verbatim:

`Delete my-project` · `Remove jane@example.com` · `Revoke prod-deploy-token`
