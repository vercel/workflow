import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const withMDX = createMDX();

const config: NextConfig = {
  experimental: {
    turbopackFileSystemCacheForDev: true,
  },

  typescript: {
    ignoreBuildErrors: true,
  },

  outputFileTracingIncludes: {
    '/og/\\[\\.\\.\\.slug\\]': ['./lib/og/assets/**/*'],
    '/worlds/\\[id\\]/opengraph-image': ['./lib/og/assets/**/*'],
  },

  async redirects() {
    return [
      {
        source: '/docs',
        destination: '/docs/getting-started',
        permanent: true,
      },
      {
        source: '/v4/docs',
        destination: '/v4/docs/getting-started',
        permanent: false,
      },
      // v5 is the current version and is served unprefixed, so the whole /v5
      // URL space (used while v5 was a pre-release) maps onto its unprefixed
      // equivalent. Rules further down that move an unprefixed path (the
      // api-reference restructure, the world docs) apply on the following hop.
      //
      // v4 content also links here on purpose: hrefs on a /v4 page are
      // rewritten into the /v4 view at render time, so a /v5/... href is the
      // only way for v4 content to point at the current version's page.
      //
      // Bare /v5 needs its own rule: `:path*` matches zero segments, but the
      // expanded destination is then the empty string, which Next.js emits as
      // an empty Location header.
      {
        source: '/v5',
        destination: '/',
        permanent: true,
      },
      {
        source: '/v5/:path*',
        destination: '/:path*',
        permanent: true,
      },
      {
        source: '/docs/cookbook',
        destination: '/cookbook',
        permanent: true,
      },
      {
        source: '/docs/cookbook/:path*',
        destination: '/cookbook/:path*',
        permanent: true,
      },
      {
        source: '/cookbooks',
        destination: '/cookbook',
        permanent: true,
      },
      {
        source: '/cookbooks/:path*',
        destination: '/cookbook/:path*',
        permanent: true,
      },
      {
        source: '/err/:slug',
        destination: '/docs/errors/:slug',
        permanent: true,
      },
      // Redirect old world docs to the /worlds routes. The world pages
      // (and Building a World) were removed from the versioned docs trees;
      // content/worlds/{v4,v5} is the canonical source, served at /worlds/*
      // (current) and /v4/worlds/* (maintenance).
      {
        source: '/docs/deploying/world/local-world',
        destination: '/worlds/local',
        permanent: true,
      },
      {
        source: '/docs/deploying/world/postgres-world',
        destination: '/worlds/postgres',
        permanent: true,
      },
      {
        source: '/docs/deploying/world/vercel-world',
        destination: '/worlds/vercel',
        permanent: true,
      },
      {
        source: '/v4/docs/deploying/world/local-world',
        destination: '/v4/worlds/local',
        permanent: true,
      },
      {
        source: '/v4/docs/deploying/world/postgres-world',
        destination: '/v4/worlds/postgres',
        permanent: true,
      },
      {
        source: '/v4/docs/deploying/world/vercel-world',
        destination: '/v4/worlds/vercel',
        permanent: true,
      },
      {
        source: '/docs/deploying/building-a-world',
        destination: '/worlds/building-a-world',
        permanent: true,
      },
      {
        source: '/v4/docs/deploying/building-a-world',
        destination: '/v4/worlds/building-a-world',
        permanent: true,
      },
      // The worlds listing and compare pages are unversioned; send the
      // version-prefixed URLs (reachable via the render-time /v4 link
      // rewrite on maintenance pages) to the canonical routes.
      {
        source: '/v4/worlds',
        destination: '/worlds',
        permanent: false,
      },
      {
        source: '/v4/worlds/compare',
        destination: '/worlds/compare',
        permanent: false,
      },
      {
        source: '/docs/worlds',
        destination: '/worlds',
        permanent: true,
      },
      // Foundations "Common Patterns" page was retired in favor of dedicated
      // cookbook recipes. Path-level redirect lands visitors on the cookbook
      // overview where each pattern (Sequential & Parallel, Workflow
      // Composition, Timeouts, etc.) has its own page. Note: anchor fragments
      // from old links (#timeout-pattern, #direct-await-flattening, etc.) are
      // dropped on redirect — Next.js redirects() does not match anchors.
      {
        source: '/docs/foundations/common-patterns',
        destination: '/cookbook',
        permanent: true,
      },
      {
        source: '/docs/foundations/control-flow-patterns',
        destination: '/cookbook',
        permanent: true,
      },
      // The Migration Guides section was replaced by Comparisons (#2676):
      // each migrating-from-* page's content folded into the matching
      // workflow-sdk-vs-* comparison page. Permanent redirects keep old
      // links and indexed search results working. The /v5-prefixed
      // equivalents are intentionally omitted: those URLs carried noindex,
      // and the /v5 prefix collapses into the unprefixed space when v5
      // becomes the default docs version.
      {
        source: '/docs/migration-guides',
        destination: '/docs/comparisons',
        permanent: true,
      },
      {
        source: '/docs/migration-guides/migrating-from-inngest',
        destination: '/docs/comparisons/workflow-sdk-vs-inngest',
        permanent: true,
      },
      {
        source: '/docs/migration-guides/migrating-from-temporal',
        destination: '/docs/comparisons/workflow-sdk-vs-temporal',
        permanent: true,
      },
      {
        source: '/docs/migration-guides/migrating-from-trigger-dev',
        destination: '/docs/comparisons/workflow-sdk-vs-trigger-dev',
        permanent: true,
      },
      {
        source: '/docs/migration-guides/migrating-from-aws-step-functions',
        destination: '/docs/comparisons/workflow-sdk-vs-aws-step-functions',
        permanent: true,
      },
      // Docs pages also expose text/markdown alternates at `<page>.md`.
      {
        source: '/docs/migration-guides.md',
        destination: '/docs/comparisons.md',
        permanent: true,
      },
      {
        source: '/docs/migration-guides/migrating-from-inngest.md',
        destination: '/docs/comparisons/workflow-sdk-vs-inngest.md',
        permanent: true,
      },
      {
        source: '/docs/migration-guides/migrating-from-temporal.md',
        destination: '/docs/comparisons/workflow-sdk-vs-temporal.md',
        permanent: true,
      },
      {
        source: '/docs/migration-guides/migrating-from-trigger-dev.md',
        destination: '/docs/comparisons/workflow-sdk-vs-trigger-dev.md',
        permanent: true,
      },
      {
        source: '/docs/migration-guides/migrating-from-aws-step-functions.md',
        destination: '/docs/comparisons/workflow-sdk-vs-aws-step-functions.md',
        permanent: true,
      },
      // Anything else under the retired section lands on the index.
      {
        source: '/docs/migration-guides/:path*',
        destination: '/docs/comparisons',
        permanent: false,
      },
      // Cookbook: child-workflows and distributed-abort-controller moved
      // from common-patterns (now "Reliability Patterns") to advanced
      {
        source: '/cookbook/common-patterns/child-workflows',
        destination: '/cookbook/advanced/child-workflows',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/distributed-abort-controller',
        destination: '/cookbook/advanced/distributed-abort-controller',
        permanent: true,
      },
      // Cookbook: stop-workflow → agent-stop-signal → agent-cancellation.
      // The page now covers both Hard Cancellation (run.cancel()) and Stop
      // Signal (hook + Promise.race) as named patterns, so the broader
      // "Agent Cancellation" title fits both. Both prior URLs land directly
      // on the current page (no redirect chains).
      {
        source: '/cookbook/agent-patterns/stop-workflow',
        destination: '/cookbook/agent-patterns/agent-cancellation',
        permanent: true,
      },
      {
        source: '/cookbook/agent-patterns/agent-stop-signal',
        destination: '/cookbook/agent-patterns/agent-cancellation',
        permanent: true,
      },
      // setAttributes graduated from experimental_setAttributes; the API
      // reference page moved with it.
      {
        source: '/docs/api-reference/workflow/experimental-set-attributes',
        destination: '/docs/api-reference/workflow/set-attributes',
        permanent: true,
      },
      // setAttributes is v5-only, so neither the graduated nor the
      // experimental path has a page in the v4 tree; both land on the
      // section index.
      {
        source: '/v4/docs/api-reference/workflow/experimental-set-attributes',
        destination: '/v4/docs/api-reference/workflow',
        permanent: false,
      },
      {
        source: '/python',
        destination: '/docs/getting-started/python',
        permanent: true,
      },
      // API reference restructure: getWorld and the World SDK moved from the
      // workflow-api section to workflow-runtime, and the observability
      // utilities page became its own workflow-observability section —
      // matching the `workflow/runtime` and `workflow/observability` import
      // paths these APIs are actually exported from. The observability rules
      // must come before the world/:path* catch-alls (first match wins).
      {
        source: '/docs/api-reference/workflow-api/world/observability',
        destination: '/docs/api-reference/workflow-observability',
        permanent: true,
      },
      {
        source: '/v4/docs/api-reference/workflow-api/world/observability',
        destination: '/v4/docs/api-reference/workflow-observability',
        permanent: true,
      },
      {
        source: '/docs/api-reference/workflow-api/get-world',
        destination: '/docs/api-reference/workflow-runtime/get-world',
        permanent: true,
      },
      {
        source: '/v4/docs/api-reference/workflow-api/get-world',
        destination: '/v4/docs/api-reference/workflow-runtime/get-world',
        permanent: true,
      },
      {
        source: '/docs/api-reference/workflow-api/world',
        destination: '/docs/api-reference/workflow-runtime/world',
        permanent: true,
      },
      {
        source: '/v4/docs/api-reference/workflow-api/world',
        destination: '/v4/docs/api-reference/workflow-runtime/world',
        permanent: true,
      },
      {
        source: '/docs/api-reference/workflow-api/world/:path*',
        destination: '/docs/api-reference/workflow-runtime/world/:path*',
        permanent: true,
      },
      {
        source: '/v4/docs/api-reference/workflow-api/world/:path*',
        destination: '/v4/docs/api-reference/workflow-runtime/world/:path*',
        permanent: true,
      },
      // --- Version-switcher fallbacks ---
      // The version switcher adds or drops the /v4 route prefix without
      // checking that the page exists in the target version, so pages that
      // live in only one docs tree 404 on switch. Each rule below covers a
      // page missing from one version and lands on the nearest equivalent
      // (usually the section index). All are temporary redirects: they must
      // be revisited when content is backported, and the /v4 ones can be
      // dropped wholesale once the v4 docs are retired.
      //
      // Pages that exist only in v5 (v5 -> v4 switch):
      {
        source: '/v4/docs/whats-new',
        destination: '/v4/docs',
        permanent: false,
      },
      {
        source: '/v4/docs/api-reference/workflow/set-attributes',
        destination: '/v4/docs/api-reference/workflow',
        permanent: false,
      },
      {
        source:
          '/v4/docs/api-reference/workflow-errors/precondition-failed-error',
        destination: '/v4/docs/api-reference/workflow-errors',
        permanent: false,
      },
      {
        source: '/v4/docs/api-reference/workflow-runtime/world/analytics',
        destination: '/v4/docs/api-reference/workflow-runtime/world',
        permanent: false,
      },
      {
        source:
          '/v4/docs/changelog/(attributes-mvp|eager-processing|step-message-ownership)',
        destination: '/v4/docs/changelog',
        permanent: false,
      },
      {
        source: '/v4/docs/configuration',
        destination: '/v4/docs/deploying',
        permanent: false,
      },
      {
        source: '/v4/docs/configuration/:path*',
        destination: '/v4/docs/deploying',
        permanent: false,
      },
      {
        source: '/v4/docs/errors/abort-signal-timeout-in-workflow',
        destination: '/v4/docs/errors',
        permanent: false,
      },
      {
        source: '/v4/docs/foundations/cancellation',
        destination: '/v4/docs/foundations',
        permanent: false,
      },
      // v4 has no how-it-works index page; foundations is the closest
      // conceptual landing for the v5 cancellation internals page.
      {
        source: '/v4/docs/how-it-works/cancellation',
        destination: '/v4/docs/foundations',
        permanent: false,
      },
      {
        source: '/v4/docs/getting-started/react-router',
        destination: '/v4/docs/getting-started',
        permanent: false,
      },
      {
        source: '/v4/docs/getting-started/react-router/:path*',
        destination: '/v4/docs/getting-started',
        permanent: false,
      },
      {
        source:
          '/v4/docs/internal/(nitro-native-build|nitro-web-ui|serializable-abort-controller)',
        destination: '/v4/docs/internal',
        permanent: false,
      },
      {
        source: '/v4/docs/observability/(attributes|tracing)',
        destination: '/v4/docs/observability',
        permanent: false,
      },
      // Pages that exist only in v4 (v4 -> v5 switch):
      {
        source: '/docs/api-reference/workflow-runtime/step-entrypoint',
        destination: '/docs/api-reference/workflow-runtime',
        permanent: false,
      },
      // /cookbook/advanced has no index page; fall back to the root.
      {
        source: '/cookbook/advanced/distributed-abort-controller',
        destination: '/cookbook',
        permanent: false,
      },
    ];
  },
};

export default withMDX(config);
