import { defineHook } from 'workflow';

/**
 * Mirrors vercel/o2flow's `workflows/hooks.ts`: a typed hook defined in a
 * plain shared module with NO workflow/step directives. Do not add the
 * literal directive strings anywhere in this file (not even in comments):
 * the Next.js integration's Turbopack rule matches file CONTENT for them,
 * and this module must stay outside the workflow loader to faithfully
 * reproduce the o2flow setup.
 *
 * The module is imported from two very different bundles:
 *   1. A workflow file (see `102_plain_module_hook.ts`), which calls
 *      `.create({ token })` inside the workflow — compiled by the SWC plugin.
 *   2. A plain framework API route (e.g. `app/api/resume-plain-hook/route.ts`
 *      in the Next.js workbenches), which calls `.resume(token, payload)` —
 *      bundled by the framework's own bundler (Turbopack/webpack/etc.) with
 *      no workflow directives anywhere in the route's module graph.
 *
 * The second path is the o2flow "sandbox-complete" callback shape that broke
 * with "Cannot find module as expression is too dynamic" on workflow
 * 5.0.0-beta.26 under Turbopack (fixed by #2752 in beta.28). See
 * packages/core/e2e/route-bundle-isolation.test.ts for the full story.
 */
export interface PlainModuleDoneEvent {
  ok: boolean;
  note?: string;
}

export const plainModuleDoneHook = defineHook<PlainModuleDoneEvent>();
