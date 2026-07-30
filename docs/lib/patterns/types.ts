/**
 * Registry — installable Workflow patterns powered by `shadcn add`.
 *
 * Each `RegistryItem` is a recipe (workflow + API routes + UI) you can drop
 * into your app via the shadcn CLI. The data here drives both the listing
 * page (`/patterns`) and the per-item detail page (`/patterns/[id]`).
 *
 * To add a new provider:
 *   1. Append a new `RegistryItem` to `manifest.ts`.
 *   2. Author the source snippets and reference them via `snippets`.
 *   3. Submit the corresponding registry JSON to the shadcn registry index
 *      (https://ui.shadcn.com/docs/registry/registry-index) so the
 *      `installCommand` actually resolves.
 */

/**
 * Workflow SDK major versions a pattern can declare compatibility with.
 * Extend this union when a new major ships (e.g. `| 'v6'`).
 */
export type WorkflowVersion = 'v4' | 'v5';

/**
 * What kind of artifact a pattern is — based on what the installed code is
 * worth after adaptation:
 *
 * - `component` — the installed code IS the value. Import it and call it;
 *   domain-free (e.g. Kill Switch, Semaphore).
 * - `template` — the structure is the value. Keep the skeleton, replace the
 *   function bodies with your domain logic (e.g. Saga, Batching).
 * - `example` — the lesson is the value. Read it, then mostly rewrite
 *   (tutorials and provider integrations).
 */
export type RegistryPatternType = 'component' | 'template' | 'example';

export type RegistryCategory =
  | 'provider'
  | 'agent'
  | 'vercel'
  | 'advanced'
  | 'common'
  | 'storage'
  | 'ai'
  | 'auth'
  | 'payments'
  | 'communication'
  | 'other';

export interface RegistryEnvVar {
  /** Variable name as it appears in `.env`. */
  name: string;
  /** One-line description of what the variable is. */
  description: string;
  /** URL the user can visit to obtain a key. */
  getKeyUrl?: string;
  /** Optional human-readable example value, e.g. `re_********`. */
  exampleValue?: string;
}

export interface RegistryFile {
  /** Path the file lands at after install, relative to the project root. */
  path: string;
  /** Short blurb shown next to the path on the detail page. */
  description: string;
}

export interface RegistrySnippet {
  /** Tab label shown above the code block. */
  label: string;
  /**
   * What this snippet is for on the detail page:
   * - `source` (default) — implementation code, rendered in the Source
   *   ("under the hood") section.
   * - `usage` — consumer-facing API examples, rendered in their own Usage
   *   section right after Installation. This is the "how do I call it"
   *   surface for installable components.
   */
  role?: 'source' | 'usage';
  /** Shiki language identifier (`tsx`, `ts`, `bash`, …). */
  lang: string;
  /** Raw source code — rendered via shiki on the server. */
  code: string;
  /**
   * Richly-commented version of `code` installed via the shadcn CLI.
   * When present, the `/r/[name]` route serves this instead of `code` so
   * the file landing in the user's project includes agent-friendly comments
   * (PATTERN, USEFUL WHEN, TO ADAPT, inline "why" notes) without cluttering
   * the UI. Falls back to `code` when absent.
   */
  installCode?: string;
  /** Optional caption rendered above the snippet (e.g. file path). */
  caption?: string;
  /**
   * Optional prose rendered between the caption and the code block.
   * Use for per-tab context that isn't obvious from the code alone
   * (e.g. "The approval route imports the hook definition and calls .resume()…").
   */
  description?: string;
}

/**
 * Identifier for a provider brand mark. The Card / Detail hero look this up
 * in `components/patterns/logos` to render the actual SVG. Adding a new
 * provider:
 *   1. Drop a `logo-<id>.tsx` SVG component in `components/patterns/logos`
 *      that paints with `currentColor`.
 *   2. Register it in `components/patterns/logos/index.ts`.
 *   3. Reference its key here.
 */
export type RegistryLogoId =
  | 'resend'
  | 'ai-sdk'
  | 'sandbox'
  | 'chat-sdk'
  | 'durable-agent'
  | 'human-in-the-loop'
  | 'agent-cancellation'
  | 'sequential-and-parallel'
  | 'workflow-composition'
  | 'saga'
  | 'batching'
  | 'handling-rate-limits'
  | 'scheduling'
  | 'timeouts'
  | 'idempotency'
  | 'webhooks'
  | 'child-workflows'
  | 'kill-switch'
  | 'upgrading-workflows'
  | 'semaphore'
  | 'rate-limiter'
  | 'circuit-breaker'
  | 'debounce'
  | 'batch-aggregator'
  | 'singleton-run'
  | 'polling'
  | 'dead-letter-queue'
  | 'recurring-cron'
  | 'stripe'
  | 'slack-approval';

/**
 * Comparison table for patterns that have multiple valid approaches.
 * First column is the "Aspect" label; remaining columns are approach names.
 */
export interface RegistryApproachTable {
  /** Section heading. Defaults to "Choosing an approach" when omitted. */
  title?: string;
  /** Optional prose intro rendered above the bullet summaries and table. */
  description?: string;
  /** Short bullet summaries of each approach, rendered before the table. Supports **bold** and `code` inline syntax. */
  bullets?: string[];
  columns: string[];
  rows: { aspect: string; values: string[] }[];
  /** Optional closing sentence rendered below the table. */
  closing?: string;
}

/**
 * A per-approach section for patterns that have multiple distinct
 * implementations (e.g. Hard Cancellation vs Stop Signal). When present on
 * a guide, the detail page replaces the unified Overview/Concept layout with
 * individual h2 sections — one per approach — each with its own code and an
 * optional dedicated install command.
 */
export interface RegistryApproachSection {
  /** Section heading — becomes an h2 on the detail page and a ToC entry. */
  title: string;
  /** Optional prose rendered under the heading. */
  description?: string;
  /**
   * If this specific approach has its own shadcn install slug, show it here.
   * Use when only one of the approaches is installable (e.g. Stop Signal),
   * while the other is a one-liner built into the SDK (e.g. Hard Cancel).
   */
  installSlug?: string;
  /**
   * Which `conceptSnippets` to render for this approach, matched by label.
   * Order is preserved.
   */
  snippetLabels: string[];
  /**
   * Bullet points rendered after the code (e.g. consequences of this approach).
   * Supports **bold** and `code` inline syntax.
   */
  afterBullets?: string[];
  /** Closing paragraph rendered after afterBullets. */
  afterProse?: string;
  /** Optional callout rendered after afterBullets/afterProse. */
  callout?: {
    type: 'info' | 'warn' | 'tip';
    content: string;
  };
}

/**
 * Inline guide content that turns the patterns detail page into a unified
 * educational + plug-and-play surface. Replaces the need for a separate
 * cookbook page for the same pattern.
 */
export interface RegistryGuide {
  /**
   * One or two educational paragraphs explaining the pattern and its variants.
   * Rendered as prose before the when-to-use list and comparison table.
   */
  overview?: string;
  /**
   * Short feature bullets rendered directly under longDescription (no heading).
   * Good for surfacing 3-4 concrete capabilities before the deeper sections.
   */
  introBullets?: string[];
  /**
   * Optional mermaid diagram string rendered after longDescription/introBullets.
   * Use for patterns with a clear data-flow that's easier to understand
   * visually. The section title defaults to "How it fits together".
   */
  diagram?: string;
  /** Override the default "How it fits together" diagram section title. */
  diagramTitle?: string;
  /**
   * Optional prose + bullets rendered immediately after the diagram.
   * Use to explain the key integration points shown in the diagram
   * (e.g. "Inbound — …" / "Outbound — …" for Chat SDK).
   */
  diagramContext?: {
    prose?: string;
    bullets?: string[];
  };
  /**
   * Optional "Why use this" section rendered before "When to use this".
   * Explains what the naive approach looks like without this pattern
   * and what becomes possible with it. Defaults to "Why use this".
   */
  whySection?: {
    title?: string;
    /** Prose introducing the problem (e.g. "Without Workflow, you'd need…"). */
    problemProse?: string;
    /** Bullets describing the pain points of the naive approach. */
    problemBullets?: string[];
    /** Prose introducing what this pattern enables. */
    solutionProse?: string;
    /** Bullets describing what the pattern unlocks. */
    solutionBullets?: string[];
    /** Optional closing sentence after the solution bullets. */
    closingProse?: string;
  };
  /** "When to use this" bullet points. */
  whenToUse?: string[];
  /**
   * Side-by-side comparison of multiple approaches — e.g. Hard Cancel vs
   * Stop Signal. Only needed when the pattern has meaningful trade-offs worth
   * calling out explicitly.
   */
  approaches?: RegistryApproachTable;
  /**
   * When true, "When to use" and "Choosing an approach" render as top-level
   * h2s instead of being nested under an "Overview" umbrella. Use this for
   * single-pattern items (no approachSections) that still want a flat layout
   * matching the cookbook structure.
   */
  flatLayout?: boolean;
  /**
   * When defined, the page splits into per-approach h2 sections instead of
   * the unified Concept tab view. Each section shows its own code and an
   * optional install command. "When to use" and "Choosing an approach" are
   * promoted to top-level h2s (no umbrella Overview heading).
   */
  approachSections?: RegistryApproachSection[];
  /** Numbered "how it works" steps. */
  howItWorks?: string[];
  /**
   * Optional prose rendered after the numbered howItWorks list.
   * Good for a single closing sentence that ties the steps together.
   */
  howItWorksClosing?: string;
  /** Optional callout rendered inside the How it works section. */
  callout?: {
    type: 'info' | 'warn' | 'tip';
    content: string;
  };
  /**
   * Replaces the generic "A preview of the code that gets copied into your app."
   * description in the Source section with a pattern-specific explanation.
   */
  sourceDescription?: string;
  /** Bullet-point adaptation tips (or pitfalls, etc.). */
  adapting?: string[];
  /** Override the "Adapting this" heading. */
  adaptingTitle?: string;
  /** Optional prose intro rendered before the adapting bullets. */
  adaptingIntro?: string;
  /** Key API links rendered at the bottom of the page. */
  keyApis?: { label: string; url: string }[];
}

export interface RegistryItem {
  /** Slug used in the URL — `/patterns/${id}`. */
  id: string;
  /** Display name. */
  name: string;
  /** Provider brand-mark identifier; rendered on the card + detail hero. */
  logo?: RegistryLogoId;
  /** Short blurb (≤ 160 chars). Shown on the listing card and detail hero. */
  description: string;
  /** Long-form description rendered as a paragraph on the detail page. */
  longDescription?: string;
  /** Searchable tags rendered as small badges. */
  tags: string[];
  /**
   * Categories the item belongs to. Items can live in more than one — e.g. AI
   * SDK is both an `agent` pattern and a `vercel`-built integration. Each
   * category renders as its own badge on the card and matches every relevant
   * filter on the listing page.
   */
  categories: RegistryCategory[];
  /**
   * Workflow SDK major versions this pattern works with, rendered as badges
   * on the listing card and detail hero. A pattern that relies on
   * version-specific APIs lists only the versions it supports (e.g. `['v5']`
   * for one built on v5-only features).
   */
  versions: WorkflowVersion[];
  /**
   * Component / template / example — drives the type badge and the type
   * filter on the listing page. See `RegistryPatternType` for definitions.
   */
  patternType: RegistryPatternType;
  /** Provider homepage / product page. */
  homepage: string;
  /** Provider docs entry-point linked from the detail hero. */
  docsUrl?: string;
  /** Public GitHub source URL for the snippet, when it lives in a public repo. */
  sourceUrl?: string;
  /**
   * shadcn registry slug — the exact argument you'd pass to
   * `pnpm dlx shadcn@latest add ${shadcnSlug}`. Use the JSON URL or the
   * registered short-name. While the registry PR is in flight this can be a
   * placeholder; the install command on the detail page will reflect it
   * verbatim.
   */
  shadcnSlug: string;
  /**
   * Set to `false` for purely educational patterns (tutorials/concepts)
   * where the installed code would be all placeholder. Hides the
   * Installation section and the install slug; the page renders as a
   * read-and-adapt guide. Defaults to `true`.
   */
  installable?: boolean;
  /**
   * npm packages the installed files import (beyond `workflow`, which a
   * workflow app has by definition). Emitted in the shadcn registry payload
   * so the CLI installs them; `validate-registry` cross-checks this list
   * against the actual imports in the emitted files.
   */
  dependencies?: string[];
  /** Required environment variables. */
  envVars?: RegistryEnvVar[];
  /** Files that get added to the user's project on install. */
  files: RegistryFile[];
  /** Code snippets shown on the detail page (workflow source, usage, etc.). */
  snippets: RegistrySnippet[];
  /**
   * Inline guide content — when present, the detail page renders educational
   * sections (overview, how it works, adapting, key APIs) so the page serves
   * as both cookbook and plug-and-play reference.
   */
  guide?: RegistryGuide;
  /**
   * Simplified conceptual snippets for patterns where the educational code is
   * genuinely different from the plug-and-play shadcn code. When present,
   * the Source section renders these under a "Concept" heading before the
   * production snippets.
   */
  conceptSnippets?: RegistrySnippet[];
}
