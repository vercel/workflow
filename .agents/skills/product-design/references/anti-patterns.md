# Anti-Pattern Catalog

Bad→good catalog for the observability UI (`packages/web` and `packages/web-shared`) copy. Rule slugs decoded in [`rules.md`](rules.md).

## Contents

- [Anti-Pattern Catalog](#anti-pattern-catalog)
  - [Contents](#contents)
  - [Voice \& Structure](#voice--structure)
  - [Redundant Copy](#redundant-copy)
  - [Please / Just / Simply / Actually](#please--just--simply--actually)
  - [Inclusive Language](#inclusive-language)
  - [AI-Slop Words](#ai-slop-words)
  - [Filler Openers](#filler-openers)
  - [Generic CTAs](#generic-ctas)
  - [Destructive-Action Errors](#destructive-action-errors)
  - [Error Messages](#error-messages)
  - [Tone in Errors](#tone-in-errors)
  - [Validation Specificity](#validation-specificity)
  - [Toasts](#toasts)
  - [Empty States](#empty-states)
  - [Loading \& Progress](#loading--progress)
  - [Permission / Consent](#permission--consent)
  - [Typographic](#typographic)
  - [Punctuation](#punctuation)
  - [Terminology Drift](#terminology-drift)
    - [Sign Up vs. Log In (Canonical)](#sign-up-vs-log-in-canonical)
    - [Verification Code vs. OTP (Scoped)](#verification-code-vs-otp-scoped)
  - [Component-API Drift](#component-api-drift)
  - [Permission / Limit States](#permission--limit-states)
  - [Audit Log Entries](#audit-log-entries)
  - [Long-Form Copy That Should Be a Sentence](#long-form-copy-that-should-be-a-sentence)

---

## Voice & Structure

| Bad                                                                                     | Good                                                        | Rule                                                   |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `A code has been sent to your email.`                                                   | `We sent a code to your email.`                             | rule/active-voice                                      |
| `Your passkey could not be verified.`                                                   | `Couldn’t verify your passkey. Try again.`                  | rule/active-voice + next step                          |
| `We have sent a code to you@email.com. Enter it below.`                                 | `We sent a code to you@email.com.`                          | rule/brief. The input field implies the next step.     |
| `Open your authenticator app to view your authentication code and enter it to sign in.` | `Enter the code from your authenticator app.`               | rule/brief                                             |
| `If you don’t have an account yet, we have sent a code to you@email.com.`               | `If you’re new to Vercel, we sent a code to you@email.com.` | rule/brief, rule/name-the-thing                        |
| `PRODUCT will delete your Blob Store, along with all of its items.`                     | `{blobName} and all its blobs will be permanently deleted.` | rule/active-voice. The product doesn’t narrate itself. |
| `You must enter a valid code with exactly 6 characters.`                                | `Code must be 6 digits.`                                    | rule/brief                                             |

## Redundant Copy

Say it once, say it well. If the heading explains it, the intro is redundant. If the button is clear, don’t explain it again.

| Bad                                                                                                                                     | Good                                                                                                                      | Rule                               | Why                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| Title `Delete Project` + body `This will delete your project.`                                                                          | Title `Delete Project` + body `{projectName} and all its deployments will be permanently deleted. This cannot be undone.` | rule/brief                         | Don’t restate the title; name the consequence                           |
| Title `No deployments yet` + description `You haven’t deployed anything yet.`                                                           | Title `No deployments yet` + description `Push to your Git repository to create your first one.`                          | rule/brief                         | Description must add new information                                    |
| Button `Save Changes` + tooltip `Click to save your changes`                                                                            | Button `Save Changes` (no tooltip needed)                                                                                 | rule/brief                         | Tooltip restates the button                                             |
| Heading `Settings` + intro paragraph `This is the settings page where you can configure your settings.`                                 | Heading `Settings` (no intro needed)                                                                                      | rule/brief                         | The page IS the settings                                                |
| Note `Heads up: This action is not reversible. Please be certain.`                                                                      | Note `This cannot be undone.`                                                                                             | rule/banned-words                  | Drop preamble + redundant warning                                       |
| Label `Project Name` + helper `Enter the name of your project.`                                                                         | Label `Project Name` (no helper)                                                                                          | rule/helper-adds-not-paraphrases   | Helper restates the label                                               |
| Label `Domain` + placeholder `example.com` + helper `Provide your domain.`                                                              | Label `Domain` + placeholder `example.com` (no helper)                                                                    | rule/helper-adds-not-paraphrases   | Helper restates the placeholder                                         |
| Label `Custom Prefix` + suffix `_READ_WRITE_TOKEN` + helper `Prepended to the env vars created for this Blob Store.`                    | Label `Custom Environment Variable Prefix` + suffix `_READ_WRITE_TOKEN` (no helper)                                       | rule/label-over-paraphrased-helper | Suffix already shows the result; fold information into a 4–6 word label |
| Multi-select trigger renders `Production, Preview` + helper `Production and Preview will get this value.`                               | Multi-select alone (trigger output IS the description)                                                                    | rule/trigger-state-as-description  | Trigger state is a real-time description; static helper duplicates it   |
| Checkbox group `Notifications` with `Email me on deploy fail` / `Email me on weekly summary` + helper `Choose which emails to receive.` | Group + visible options (no helper)                                                                                       | rule/helper-adds-not-paraphrases   | Legend + visible options describe the choice                            |
| Optional `Company` input with placeholder `Optional`                                                                                    | Label `Company (Optional)` + example placeholder `Acme Inc.`                                                              | rule/mark-optional-fields          | Status remains visible and is announced with the control                |
| Required `Email` label with an unexplained `text-red-800` asterisk                                                                      | Explain the marker once; use an `aria-hidden` `text-red-900` asterisk plus native `required` semantics                    | rule/mark-optional-fields          | Color reinforces visible status; text and semantics carry its meaning   |

## Please / Just / Simply / Actually

`just`, `simply`, `actually` are Tier 1 (always cut). `please` and `we’re sorry` are Tier 3, banned by default; allowed for favors, app-at-fault, or inconvenience.

| Bad                                     | Good                                         | Rule              |
| --------------------------------------- | -------------------------------------------- | ----------------- |
| `Please enter your email.`              | `Enter your email.`                          | rule/banned-words |
| `Please try again.`                     | `Try again.`                                 | rule/banned-words |
| `Please be certain.`                    | (delete. `This cannot be undone.` covers it) | rule/banned-words |
| `You just need to deploy your project.` | `Deploy your project.`                       | rule/banned-words |
| `Simply click the button.`              | `Click the button.`                          | rule/banned-words |
| `Actually, this feature requires Pro.`  | `This feature requires Pro.`                 | rule/banned-words |

Allowed-`please` examples:

| Context                                           | OK                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| Asking user to retry auth after our token expired | `Please reconnect your GitHub account.`                               |
| Incident banner during outage                     | `Deployments are paused. Please check status.vercel.com for updates.` |

`we’re sorry`:

| Bad                                  | Good                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `We’re sorry, something went wrong.` | `Couldn’t load your dashboard.` (app at fault, allowed). Or `Dashboard didn’t load. Try again.` (no-blame form). |

## Inclusive Language

Tier 1 (always cut): `crazy`, `dummy`, `sanity check`.

Tier 2 (always replace):

| Bad                       | Good                                     | Rule                    |
| ------------------------- | ---------------------------------------- | ----------------------- |
| `blacklist` / `whitelist` | `blocklist` / `allowlist`                | rule/inclusive-language |
| `master/slave`            | `primary/replica` or `primary/secondary` | rule/inclusive-language |
| `kill` (process)          | `stop` / `end`                           | rule/inclusive-language |
| `hang`                    | `stop responding` / `freeze`             | rule/inclusive-language |
| `man-hours`               | `person-hours` / `staff-hours`           | rule/inclusive-language |
| `grandfathered`           | `existing` / `legacy`                    | rule/inclusive-language |
| `sanity check`            | `quick check` / `verify`                 | rule/inclusive-language |
| `crazy` (as intensifier)  | (delete)                                 | rule/inclusive-language |
| `dummy` (data, account)   | `placeholder` / `sample`                 | rule/inclusive-language |

## AI-Slop Words

| Bad                                                                                            | Good                                        | Rule              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------- |
| `Elevate your developer experience`                                                            | `Ship faster.` / (delete, marketing)        | rule/banned-words |
| `Ensure your configuration is correct` (Tier 3 padding)                                        | `Check that your configuration is correct.` | rule/banned-words |
| `Ensure the env var is set in Production before deploying` (Tier 3 allowed, means “guarantee”) | (kept as-is)                                | rule/banned-words |
| `Navigate to Settings → Domains`                                                               | `Go to Settings → Domains.`                 | rule/banned-words |
| `Whilst deploying`                                                                             | `While deploying` (or cut)                  | rule/banned-words |
| `Foster collaboration`                                                                         | `Share the project` / `Invite your team`    | rule/banned-words |
| `Harness the power of`                                                                         | (delete; describe the thing)                | rule/banned-words |
| `Unlock new capabilities`                                                                      | (delete)                                    | rule/banned-words |
| `Crafted for developers`                                                                       | `For developers`                            | rule/banned-words |
| `Comprehensive observability`                                                                  | `Logs, traces, and alerts in one view.`     | rule/banned-words |
| `A vibrant dashboard`                                                                          | (delete the adjective)                      | rule/banned-words |
| `Dive into the details`                                                                        | `See the details` / `Open the run`          | rule/banned-words |
| `Embark on your first deployment`                                                              | `Deploy your first project`                 | rule/banned-words |
| `It’s important to note that X`                                                                | `X`                                         | rule/banned-words |
| `In today’s fast-paced world`                                                                  | (delete the entire sentence)                | rule/banned-words |
| `Whether you’re a solo dev or a team of 100`                                                   | (delete, marketing preamble)                | rule/banned-words |
| `No X. No Y. Just Z.`                                                                          | Connect naturally or drop the rhythm        | AI-Slop Tells     |

## Filler Openers

| Bad                                         | Good                         | Rule              |
| ------------------------------------------- | ---------------------------- | ----------------- |
| `In order to deploy, you need to…`          | `To deploy, you need to…`    | rule/banned-words |
| `At this time, your plan does not support…` | `Your plan doesn’t support…` | rule/banned-words |
| `Please note that…`                         | (delete; lead with the fact) | rule/banned-words |
| `It’s worth noting that…`                   | (same)                       | rule/banned-words |
| `Unfortunately, we weren’t able to…`        | `Couldn’t …`                 | rule/active-voice |

## Generic CTAs

| Bad                                                                | Good                                                                     | Rule                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| `Submit`                                                           | `Deploy Project` / `Add Domain` / whatever the verb is                   | rule/destructive-names-action (Verb + Noun discipline) |
| `Confirm`                                                          | `Delete my-project` / `Transfer Ownership` / named action                | rule/destructive-names-action                          |
| `OK`                                                               | Rarely correct. Use the action name.                                     | rule/destructive-names-action                          |
| `← Back`                                                           | `Use a Different Email` / `Go to Projects`. Name the destination.        | rule/link-names-destination                            |
| `Learn more`                                                       | `Learn more about edge functions`. Name the destination.                 | rule/link-names-destination                            |
| `Click here`                                                       | Never.                                                                   | rule/link-names-destination                            |
| `Get Started`                                                      | `Connect Your GitHub Repo` / `Deploy a Template`. Name the first action. | rule/actionable                                        |
| `New Chat` when it opens an existing chat                          | `Open Chat` / `Resume Chat`                                              | rule/name-the-thing                                    |
| `Copy Page` when the object could be URL, content, route, or draft | `Copy URL` / `Duplicate Page` / `Create Draft`                           | rule/name-the-thing                                    |
| `Add to Project`                                                   | `Add Domain` / `Add Environment Variable` / name the object              | rule/name-the-thing                                    |
| `Want to review deployment settings?` as a prompt suggestion       | `Review deployment settings`                                             | rule/actionable                                        |

## Destructive-Action Errors

| Bad                                                                                                                                           | Good                                                                                                    | Rule                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `This action is not reversible. Please be certain.`                                                                                           | `This cannot be undone.`                                                                                | rule/banned-words, rule/brief                    |
| `Are you sure you want to delete this?`                                                                                                       | `{Resource name} will be permanently deleted. This cannot be undone.`                                   | rule/actionable (consequence over meta-question) |
| `{Consequence sentence.} Do you want to continue?` (trailing question after the body)                                                         | `{Consequence sentence.} This cannot be undone.`                                                        | rule/brief (button names the verb)               |
| `Permanently remove this store and all of its data from the Vercel platform. This action is not reversible, so please continue with caution.` | `Permanently delete this Blob and everything in it. This cannot be undone.`                             | rule/brief, rule/banned-words                    |
| `<Button>Confirm</Button>` on a red destructive modal                                                                                         | `<Button variant="error">Delete Blob</Button>`                                                          | rule/destructive-names-action                    |
| `<Button>Continue</Button>` on a destructive modal (named confirmation)                                                                       | `<Button variant="error">Remove SAML</Button>` / `<Button variant="error">Disable Enforcement</Button>` | rule/destructive-names-action                    |

## Error Messages

| Bad                                                                                                                       | Good                                                                                                 | Why                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `An error occurred.`                                                                                                      | Name the error: `Build failed — bundle exceeds 50 MB.` Last-resort fallback: `Something went wrong.` | Specific cause                                                                                                                                                                          |
| `An error occurred. Please try again.`                                                                                    | `Something went wrong. Try again.` (fallback only — prefer naming the actual cause)                  | Cut `please` + `occurred`. `Something went wrong` is on the [banned phrase fallback list](copy.md#banned); use only when no specific cause is available.                                |
| `Unable to verify passkey. Please try again.`                                                                             | `Couldn’t verify your passkey. Try again.`                                                           | rule/active-voice + contraction. User-action error → `Couldn’t`. For system/infra errors (`Build failed`, `Deployment failed`) `Failed to` is canonical — see `rule/couldnt-vs-failed`. |
| `The code entered is invalid.`                                                                                            | `That code is invalid. Try again.`                                                                   | Subject first + next step                                                                                                                                                               |
| `The recovery code you entered has been used or is incorrect.`                                                            | `That recovery code is invalid or already used.`                                                     | Shorter, direct                                                                                                                                                                         |
| `That password is too short.`                                                                                             | `Choose a password with at least 8 characters.`                                                      | Reframe blame to action                                                                                                                                                                 |
| `That email is invalid.`                                                                                                  | `Enter a valid email address.`                                                                       | Same reframe                                                                                                                                                                            |
| `Oops! Something went wrong.`                                                                                             | `Something went wrong. Try again.` (fallback only)                                                   | Cut the interjection. Replace with the specific cause when known (`Couldn’t verify your passkey. Try again.`).                                                                          |
| `Uh-oh, we lost your changes.`                                                                                            | `Couldn’t save your changes. Try again.`                                                             | Cut interjection; rule/active-voice                                                                                                                                                     |
| `Emptying your store took too long. Please try again later or consider deleting your blobs programatically using the SDK` | `Emptying took too long. Try again or delete blobs programmatically with the SDK.`                   | Cut `please`, shorten, fix typo                                                                                                                                                         |
| `Couldn’t import file.` as a toast-only Figma/import failure                                                              | Inline near the input: `Couldn’t import design system. The Figma file is private or unavailable.`    | Name the artifact and likely cause; put the error where the user can act                                                                                                                |
| `Payment failed.` on a blocking billing state                                                                             | `Payment failed — card has insufficient funds. Add funds or use another payment method.`             | Name the cause and route to recovery                                                                                                                                                    |

## Tone in Errors

Humor and cuteness in error states are insincere. Users hitting an error are already frustrated. Be direct, be helpful, name what to do next.

| Bad                                            | Good                                                              | Rule                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| `Oops, something went wrong! 🙃`               | `Couldn’t load your dashboard. Try again.`                        | rule/banned-words (interjection + emoji), rule/clear |
| `Whoops, that wasn’t supposed to happen.`      | `Couldn’t save your changes. Try again or check your connection.` | rule/banned-words, rule/actionable                   |
| `Yikes! That payment failed.`                  | `Payment failed — card was declined. Update your payment method.` | rule/banned-words, rule/clear                        |
| `🤔 Hmm, we couldn’t find that.`               | `Project not found. Check the URL or open Projects.`              | rule/banned-words, rule/clear                        |
| `Don’t worry, our hamsters are working on it!` | `Vercel is degraded. Follow the incident on Vercel Status.`       | rule/banned-words (no humor in errors)               |

## Validation Specificity

| Bad                                       | Good                                                                                        | Rule            | Why                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------- |
| `Invalid domain.` (generic, unactionable) | `Domain must be a valid hostname. Underscores aren’t allowed.` (names the exact constraint) | rule/clear      | Name the failure when you can compute it      |
| `Password is too weak.` (judgmental)      | `Choose a password with at least 8 characters and one number.` (action-oriented constraint) | rule/actionable | Reframe blame as action; name the constraints |

## Toasts

| Bad                                                                                                                                             | Good                                                              | Rule                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| `Deleted Blob successfully`                                                                                                                     | `Blob deleted`                                                    | rule/banned-words (`successfully`)     |
| `Domain added successfully`                                                                                                                     | `Domain added`                                                    | rule/banned-words                      |
| `Your environment variable has been saved.`                                                                                                     | `Environment variable saved`                                      | rule/active-voice, rule/period (toast) |
| `Emptied Blob Store successfully`                                                                                                               | `Blob emptied`                                                    | rule/banned-words                      |
| `toasts.success('Deployment cancelled successfully')` (user-canceled isn’t a success)                                                           | `toasts.message('Deployment canceled')` (neutral acknowledgement) | rule/term-consistency (toast method)   |
| `Updated SAML for your Team successfully` (fired when only `saml.enforced` was patched — toast names the parent feature, not the actual change) | `SAML enforcement enabled` / `SAML enforcement disabled`          | rule/name-the-thing                    |
| `Your team's IP address setting has been updated.` (passive `has been`, possessive)                                                             | `IP address visibility updated`                                   | rule/active-voice, rule/brief          |

Toast method picks by user impact, not call-site method. See patterns.md → Toast event semantics. **Toasts must name what changed, not the parent feature** — trace from the toast back to the API request body. If only `feature.subfield` was mutated, the toast says `{subfield} {state}`, not `{feature} updated`. See [`surfaces-feedback.md` → Toast Pattern by Action](surfaces-feedback.md#toast-pattern-by-action).

## Empty States

| Bad                                                                         | Good                                                                        | Rule                          | Why                                         |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------- |
| `No data.` / `Nothing here.`                                                | `No deployments yet. Push to your Git repository to create your first one.` | rule/actionable               | Dead ends panic users; point to next action |
| `Looking a little empty around here!`                                       | `No team members yet. Invite your team to start collaborating.`             | rule/banned-words (no humor)  | Clarity over cuteness                       |
| `You haven’t invited anyone yet.`                                           | `No team members yet. Invite your team to start collaborating.`             | rule/actionable               | Reframe shaming as state + action           |
| `Click "OK" to continue.`                                                   | `Deploy a starter` / named CTA                                              | rule/destructive-names-action | Name the verb + noun                        |
| Description that repeats the title verbatim                                 | Description that adds context the title doesn’t                             | rule/brief                    | Redundancy wastes the slot                  |
| `Create a Deployment` button on an empty state titled `Create a Deployment` | `Create Deployment` button; title states the absence                        | rule/brief                    | Duplicate article + redundancy              |
| Auto-launching an onboarding tour                                           | `Start Tour` button + `Skip`                                                | rule/actionable               | Consent; users skim                         |
| Decorative icon with no `aria-hidden`                                       | `<IconFoo aria-hidden="true" />`                                            | rule/a11y                     | Screen readers announce unlabeled icons     |

See [surfaces.md → Empty states](surfaces-feedback.md#empty-states) for the type framework.

## Loading & Progress

| Bad                                            | Good                                                   | Rule                          |
| ---------------------------------------------- | ------------------------------------------------------ | ----------------------------- |
| `Verifying` (with spinner)                     | `Verifying…`                                           | rule/ellipsis                 |
| `Loading...`                                   | `Loading…`                                             | rule/ellipsis                 |
| `Redirecting...`                               | `Redirecting…`                                         | rule/ellipsis                 |
| `Your project is being deployed`               | `Deploying…`                                           | rule/active-voice, rule/brief |
| Empty table while a populated search refreshes | Keep previous results visible and mark the region busy | rule/actionable               |
| `0%` progress bar before upload starts         | `Preparing upload…` until bytes are moving             | rule/clear                    |
| No cue after hiding a working log              | `Working…` / `Finished` near the affected panel        | rule/actionable               |

## Permission / Consent

| Bad                                                      | Good                                                                                     | Rule                |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------- |
| `Granted 24 permissions`                                 | `Agent can read project settings and update environment variables.`                      | rule/name-the-thing |
| `Authorize` on an agent execution approval               | `Approve Plan` / `Approve Changes`                                                       | rule/name-the-thing |
| `Authorize` on OAuth consent                             | `Allow Access`                                                                           | rule/name-the-thing |
| `All teams and projects` with no explanation or selector | `Selected teams and projects` / `All teams you can access`                               | rule/clear          |
| Raw API scopes as the primary permission list            | Grouped `Read`, `Manage`, and `Billing` capabilities with technical scopes in disclosure | rule/clear          |

## Typographic

| Bad                                                                     | Good                                                                  | Rule              |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------- |
| `"Hello"` (straight quotes)                                             | `“Hello”` (curly quotes)                                              | rule/curly-quotes |
| `Couldn't` (straight apostrophe)                                        | `Couldn’t` (curly apostrophe `’`)                                     | rule/curly-quotes |
| `A, B and C`                                                            | `A, B, and C` (Oxford comma)                                          | rule/mechanics    |
| `Deploying...`                                                          | `Deploying…` (ellipsis char `…`)                                      | rule/ellipsis     |
| `A server side function.` (modifier before noun)                        | `A server-side function.`                                             | rule/mechanics    |
| `It’s not just a deployment — it’s an experience.` (rhetorical em-dash) | `It’s a deployment.` (drop the rhetorical em-dash structure entirely) | AI-Slop Tells     |
| `Deeply — fundamentally — quietly transformative.`                      | (delete the magic-adverb chain)                                       | AI-Slop Tells     |

Em-dash as rhetorical hinge is an LLM tell. Cause-effect em-dashes like `Build failed — bundle exceeds 50 MB.` remain OK.

## Punctuation

| Bad                                                                 | Good                                                                   | Rule                    | Why                                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------- |
| `Deploy.` (button label, single clause + period)                    | `Deploy` (button labels are fragments, no period)                      | rule/period             | Fragments don’t take periods                                                                      |
| `Build failed bundle exceeds 50 MB` (multi-sentence missing period) | `Build failed. Bundle exceeds 50 MB.` (full sentence ends with period) | rule/period             | Multi-sentence strings: period on each                                                            |
| `Couldn’t Verify Your Passkey. Try Again.` (Title Case in body)     | `Couldn’t verify your passkey. Try again.` (sentence case for body)    | rule/sentence-case-body | Body text and inline links use sentence case. Title Case is for buttons, labels, and titles only. |

## Terminology Drift

| Bad                                                             | Good                                                                                                             | Rule                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------- |
| `store` / `Store` / `Blob Store` (as product name, user-facing) | `Blob` (in user-facing UI; `Blob Store` is reserved for code constants like `components/stores/constants.ts`)    | rule/term-consistency |
| `file`, `object`, `asset` (referring to a Blob)                 | `blob` (lowercase noun for an individual item)                                                                   | rule/term-consistency |
| `Deploy` (as noun)                                              | `Deployment`                                                                                                     | rule/term-consistency |
| `Cancelled`                                                     | `Canceled` (one L, matches API enum). Workflow’s `Cancelled` is the documented exception; mirror the enum there. | rule/term-consistency |
| `env var`                                                       | `Environment variable`                                                                                           | rule/term-consistency |
| `Sign in` / `Sign up` on Vercel auth surfaces                   | `Log In` / `Sign Up` (Title Case button); `log in` / `sign up` in body prose                                     | rule/term-consistency |

Uppercase `Blob` for the product/container; lowercase `blob` for an individual item.

### Sign Up vs. Log In (Canonical)

Vercel auth surfaces standardize on **`Sign Up`** and **`Log In`**.

| Surface                   | Canonical form                                               | Notes                                  |
| ------------------------- | ------------------------------------------------------------ | -------------------------------------- |
| Primary CTA — signup page | `Sign Up` (Title Case button)                                | Title Case treats `Up` as significant. |
| Primary CTA — login page  | `Log In` (Title Case button)                                 | Both words capitalized in Title Case.  |
| Logout button             | `Log Out`                                                    | Same shape.                            |
| Body prose                | `sign up`, `log in`, `log out`                               | Lowercase, two words.                  |
| Toast / audit log         | `Signed up`, `Logged in`, `Logged out`                       | Sentence case past tense.              |
| Inverse cross-link        | `Already have an account? Log In` / `New to Vercel? Sign Up` | Pair so the user can switch.           |

Embedded third-party OAuth flows preserve the partner’s verb when the destination dictates it (`Sign in with GitHub`); the surrounding Vercel chrome stays on `Log In`. Don’t mix `Sign In` and `Log In` in the same flow.

For component examples, see [surfaces.md → Auth (Sign Up & Log In)](surfaces-lifecycle.md#auth-sign-up--log-in).

### Verification Code vs. OTP (Scoped)

| Surface                                       | Canonical form                     |
| --------------------------------------------- | ---------------------------------- |
| Primary UX (heading, input label, aria-label) | `Verification code`                |
| Security settings, audit logs, MFA config     | `OTP`, `TOTP`, `one-time password` |

Internal variable, function, and test-id names can still use `otp`, `loginError`, etc. The rule is for user-visible strings only.

## Component-API Drift

| Bad                                                                                                                     | Good                                                                                                              | Rule                        | Why                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Link onClick={cancel}>← Back</Link>`                                                                                  | `<Button variant="tertiary">Use a Different Email</Button>`                                                       | rule/link-names-destination | Cancel is a button, not a link; name the outcome                                                                                                                                    |
| `<Modal.P>{PRODUCT} will delete your Blob Store…</Modal.P>`                                                             | `<Modal.P>{blobName} will be permanently deleted.</Modal.P>`                                                      | rule/active-voice           | Drop third-person product wrapper                                                                                                                                                   |
| `aria-label="One-time password"`                                                                                        | `aria-label={\`Verification code sent to ${email}\`}`                                                             | rule/a11y                   | aria-label IS the copy. Apply same rules.                                                                                                                                           |
| `<Input aria-label="Enter 6-digits code" />`                                                                            | `<Input aria-label="Enter the 6-digit code from your authenticator app" />`                                       | rule/clear                  | Grammar + name the source                                                                                                                                                           |
| `<Button aria-label="Submit form">Submit</Button>` (duplicates visible text)                                            | `<Button>Submit</Button>` (no aria-label needed when visible text exists)                                         | rule/a11y                   | aria-label overrides visible text. Screen-reader users hear “Submit form” while sighted users see “Submit”.                                                                         |
| `<Input label="Domain" aria-label="Domain field" />` (duplicates)                                                       | `<Input label="Domain" />` (label association is enough)                                                          | rule/a11y                   | aria-label is for icon-only or no-visible-text elements only                                                                                                                        |
| `<span>IP addresses are currently {hidden ? 'hidden' : 'visible'} in the Vercel Dashboard.</span>` paired with a toggle | `<span>Show in Vercel Dashboard</span>` + stable description (`When on, IP addresses appear in Firewall data, …`) | rule/toggle-stable-label    | Toggle position encodes state; the label names the setting. State-dependent labels create a state-machine of strings (8 strings for 2 settings × 2 states × heading + description). |
| `<p>{on ? 'Enabled for' : 'Disabled'}</p>` paired with a scope selector that only renders when ON                       | `<p>Require Log In</p>` with the scope selector standing alone when ON                                            | rule/toggle-stable-label    | Half-sentence labels still encode state. The label should name the affirmative aspect; let the sibling control stand alone.                                                         |
| Toggle label duplicates an adjacent persistent setting title                                                            | Use an affirmative label when it adds meaning; otherwise show `Enabled` / `Disabled` with a stable hidden name    | rule/toggle-stable-label    | The title already identifies the setting. Visible status may aid scanning, but it must not become the control’s accessible name.                                                    |
| `<Toggle>{checked ? 'Enabled' : 'Disabled'}</Toggle>` with no other accessible name                                     | Adjacent title + stable `sr-only` name + `aria-hidden` visible status                                             | rule/toggle-stable-label    | Dynamic status is not a stable accessible name. Keep the exact setting name available to assistive technology.                                                                      |
| `<Toggle>Hide IP Addresses</Toggle>` (toggle on = hide)                                                                 | `<Toggle>Show IP Addresses</Toggle>` (toggle on = show)                                                           | rule/no-negation-toggles    | Frame the on-position as the affirmative. If the underlying state variable is negated, invert at the render boundary (`checked={!hideIp}`).                                         |

## Permission / Limit States

| Bad                                                                           | Good                                                                                                                                          | Rule                                     |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `Action not permitted.`                                                       | `You don’t have permission to delete this project. Ask a team owner.`                                                                         | rule/actionable                          |
| `Additional permissions required.`                                            | `As a Viewer on Acme, you can’t edit example.com. A Developer role is required. Ask a Team Owner to Update Your Access.`                      | rule/permission-unblock-path             |
| `Only team Owners can edit example.com.`                                      | Show only the server-recommended role for that exact ACL check, or omit the role and link to the truthful resolver.                           | rule/permission-unblock-path             |
| `This feature is not available on your current plan.`                         | `Upgrade to Pro to use custom domains.`                                                                                                       | rule/actionable                          |
| `Insufficient permissions.`                                                   | `Only team owners can change billing settings.`                                                                                               | rule/clear                               |
| `Suspended Stores can’t be deleted.`                                          | `Cannot delete a suspended Blob.`                                                                                                             | rule/term-consistency                    |
| `You do not have permission to delete this store.`                            | `You don’t have permission to delete this Blob.`                                                                                              | rule/curly-quotes, rule/term-consistency |
| `You don’t have permission to add example.com.` (wrong route, user can’t act) | `example.com is registered to another team. Use a different domain or transfer it.` (names the constraint, routes to legitimate alternatives) | rule/actionable                          |

Cross-tenant denials route to the resolver, not the user’s own owner.

## Audit Log Entries

| Bad                                             | Good                                                                                            | Rule              | Why                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------- |
| `User is deleting project` (present continuous) | `Jane Smith deleted project my-app` (past tense, named actor)                                   | rule/mechanics    | Audit log entries are past tense, third person, named |
| `Project was deleted` (passive, no actor)       | `[Vercel CI] deleted project my-app at 2026-04-27T14:23:00Z` (active, system actor in brackets) | rule/active-voice | Always name the actor                                 |

## Long-Form Copy That Should Be a Sentence

| Bad                                                                                                                                                                                                                                                                                                                | Good                                                                                        | Rule       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------- |
| `PRODUCT will delete all Blob files in this Blob Store for you. PRODUCT recommends that you ensure this Blob Store is no longer used by any projects before continuing. There are N blobs in this store. If you run into issues, please try again or consider deleting your Blobs programmatically using the SDK.` | `All {count} blobs in {blobName} will be permanently deleted. The Blob itself will remain.` | rule/brief |
| `Finish linking your existing Vercel account to GitHub by entering the code we sent to you@email.com.`                                                                                                                                                                                                             | `To finish connecting GitHub, enter the code we sent to you@email.com.`                     | rule/brief |

When in doubt: cut half, then read it aloud.
