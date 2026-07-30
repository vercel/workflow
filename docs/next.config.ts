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
        source: '/v5/docs',
        destination: '/v5/docs/getting-started',
        permanent: false,
      },
      {
        source: '/docs/cookbook',
        destination: '/patterns',
        permanent: true,
      },
      {
        source: '/docs/cookbook/:path*',
        destination: '/patterns',
        permanent: true,
      },
      {
        source: '/cookbooks',
        destination: '/patterns',
        permanent: true,
      },
      {
        source: '/cookbooks/:path*',
        destination: '/patterns',
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
      // (current) and /v5/worlds/* (pre-release).
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
        source: '/v5/docs/deploying/world/local-world',
        destination: '/v5/worlds/local',
        permanent: true,
      },
      {
        source: '/v5/docs/deploying/world/postgres-world',
        destination: '/v5/worlds/postgres',
        permanent: true,
      },
      {
        source: '/v5/docs/deploying/world/vercel-world',
        destination: '/v5/worlds/vercel',
        permanent: true,
      },
      {
        source: '/docs/deploying/building-a-world',
        destination: '/worlds/building-a-world',
        permanent: true,
      },
      {
        source: '/v5/docs/deploying/building-a-world',
        destination: '/v5/worlds/building-a-world',
        permanent: true,
      },
      // The worlds listing and compare pages are unversioned; send the
      // version-prefixed URLs (reachable via the render-time /v5 link
      // rewrite on pre-release pages) to the canonical routes.
      {
        source: '/v5/worlds',
        destination: '/worlds',
        permanent: false,
      },
      {
        source: '/v5/worlds/compare',
        destination: '/worlds/compare',
        permanent: false,
      },
      {
        source: '/docs/worlds',
        destination: '/worlds',
        permanent: true,
      },
      // Foundations "Common Patterns" page was retired — now part of /patterns
      {
        source: '/docs/foundations/common-patterns',
        destination: '/patterns',
        permanent: true,
      },
      {
        source: '/docs/foundations/control-flow-patterns',
        destination: '/patterns',
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
      // /registry → /patterns (renamed)
      { source: '/registry', destination: '/patterns', permanent: true },
      {
        source: '/registry/:id',
        destination: '/patterns/:id',
        permanent: true,
      },
      // Renamed patterns
      {
        source: '/patterns/distributed-abort-controller',
        destination: '/patterns/kill-switch',
        permanent: true,
      },
      {
        source: '/r/distributed-abort-controller',
        destination: '/r/kill-switch',
        permanent: true,
      },
      {
        source: '/patterns/rate-limiting',
        destination: '/patterns/handling-rate-limits',
        permanent: true,
      },
      {
        source: '/r/rate-limiting',
        destination: '/r/handling-rate-limits',
        permanent: true,
      },
      // Cookbook → Patterns redirects (cookbook pages merged into patterns)
      { source: '/cookbook', destination: '/patterns', permanent: true },
      {
        source: '/cookbook/agent-patterns/agent-cancellation',
        destination: '/patterns/agent-cancellation',
        permanent: true,
      },
      {
        source: '/cookbook/agent-patterns/stop-workflow',
        destination: '/patterns/agent-cancellation',
        permanent: true,
      },
      {
        source: '/cookbook/agent-patterns/agent-stop-signal',
        destination: '/patterns/agent-cancellation',
        permanent: true,
      },
      {
        source: '/cookbook/agent-patterns/durable-agent',
        destination: '/patterns/durable-agent',
        permanent: true,
      },
      {
        source: '/cookbook/agent-patterns/human-in-the-loop',
        destination: '/patterns/human-in-the-loop',
        permanent: true,
      },
      {
        source: '/cookbook/integrations/ai-sdk',
        destination: '/patterns/ai-sdk',
        permanent: true,
      },
      {
        source: '/cookbook/integrations/chat-sdk',
        destination: '/patterns/chat-sdk',
        permanent: true,
      },
      {
        source: '/cookbook/integrations/sandbox',
        destination: '/patterns/sandbox',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/batching',
        destination: '/patterns/batching',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/idempotency',
        destination: '/patterns/idempotency',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/rate-limiting',
        destination: '/patterns/handling-rate-limits',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/saga',
        destination: '/patterns/saga',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/scheduling',
        destination: '/patterns/scheduling',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/sequential-and-parallel',
        destination: '/patterns/sequential-and-parallel',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/timeouts',
        destination: '/patterns/timeouts',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/webhooks',
        destination: '/patterns/webhooks',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/workflow-composition',
        destination: '/patterns/workflow-composition',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/child-workflows',
        destination: '/patterns/child-workflows',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/distributed-abort-controller',
        destination: '/patterns/kill-switch',
        permanent: true,
      },
      {
        source: '/cookbook/advanced/child-workflows',
        destination: '/patterns/child-workflows',
        permanent: true,
      },
      {
        source: '/cookbook/advanced/distributed-abort-controller',
        destination: '/patterns/kill-switch',
        permanent: true,
      },
      // v5 cookbook pages merged into patterns (only advanced/serializable-steps
      // and advanced/publishing-libraries remain as docs)
      { source: '/v5/cookbook', destination: '/patterns', permanent: true },
      {
        source: '/v5/cookbook/agent-patterns/:id',
        destination: '/patterns/:id',
        permanent: true,
      },
      {
        source: '/v5/cookbook/common-patterns/:id',
        destination: '/patterns/:id',
        permanent: true,
      },
      {
        source: '/v5/cookbook/integrations/:id',
        destination: '/patterns/:id',
        permanent: true,
      },
      {
        source: '/v5/cookbook/advanced/child-workflows',
        destination: '/patterns/child-workflows',
        permanent: true,
      },
      {
        source: '/v5/cookbook/advanced/upgrading-workflows',
        destination: '/patterns/upgrading-workflows',
        permanent: true,
      },
      // setAttributes graduated from experimental_setAttributes; the API
      // reference page moved with it.
      {
        source: '/v5/docs/api-reference/workflow/experimental-set-attributes',
        destination: '/v5/docs/api-reference/workflow/set-attributes',
        permanent: true,
      },
      // setAttributes is v5-only, so the unversioned path has no page yet.
      // Land on the section index directly (no redirect chain through the
      // /docs/api-reference/workflow/set-attributes fallback below). Point
      // this at /docs/api-reference/workflow/set-attributes once v5 becomes
      // the default version.
      {
        source: '/docs/api-reference/workflow/experimental-set-attributes',
        destination: '/docs/api-reference/workflow',
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
        source: '/v5/docs/api-reference/workflow-api/world/observability',
        destination: '/v5/docs/api-reference/workflow-observability',
        permanent: true,
      },
      {
        source: '/docs/api-reference/workflow-api/get-world',
        destination: '/docs/api-reference/workflow-runtime/get-world',
        permanent: true,
      },
      {
        source: '/v5/docs/api-reference/workflow-api/get-world',
        destination: '/v5/docs/api-reference/workflow-runtime/get-world',
        permanent: true,
      },
      {
        source: '/docs/api-reference/workflow-api/world',
        destination: '/docs/api-reference/workflow-runtime/world',
        permanent: true,
      },
      {
        source: '/v5/docs/api-reference/workflow-api/world',
        destination: '/v5/docs/api-reference/workflow-runtime/world',
        permanent: true,
      },
      {
        source: '/docs/api-reference/workflow-api/world/:path*',
        destination: '/docs/api-reference/workflow-runtime/world/:path*',
        permanent: true,
      },
      {
        source: '/v5/docs/api-reference/workflow-api/world/:path*',
        destination: '/v5/docs/api-reference/workflow-runtime/world/:path*',
        permanent: true,
      },
      // --- Version-switcher fallbacks ---
      // The version switcher swaps the /v5 route prefix without checking
      // that the page exists in the target version, so pages that exist in
      // only one docs tree 404 on switch. Each rule below covers a page
      // missing from one version and lands on the nearest equivalent
      // (usually the section index). All are temporary redirects: they must
      // be revisited when content is backported or when v5 becomes the
      // default version (which swaps the trees served at /docs).
      //
      // Pages that exist only in v5 (v5 -> v4 switch):
      {
        source: '/docs/api-reference/workflow/set-attributes',
        destination: '/docs/api-reference/workflow',
        permanent: false,
      },
      {
        source: '/docs/api-reference/workflow-errors/precondition-failed-error',
        destination: '/docs/api-reference/workflow-errors',
        permanent: false,
      },
      {
        source: '/docs/api-reference/workflow-runtime/world/analytics',
        destination: '/docs/api-reference/workflow-runtime/world',
        permanent: false,
      },
      {
        source:
          '/docs/changelog/(attributes-mvp|eager-processing|step-message-ownership)',
        destination: '/docs/changelog',
        permanent: false,
      },
      {
        source: '/docs/configuration',
        destination: '/docs/deploying',
        permanent: false,
      },
      {
        source: '/docs/configuration/:path*',
        destination: '/docs/deploying',
        permanent: false,
      },
      {
        source: '/docs/errors/abort-signal-timeout-in-workflow',
        destination: '/docs/errors',
        permanent: false,
      },
      {
        source: '/docs/foundations/cancellation',
        destination: '/docs/foundations',
        permanent: false,
      },
      // v4 has no how-it-works index page; foundations is the closest
      // conceptual landing for the v5 cancellation internals page.
      {
        source: '/docs/how-it-works/cancellation',
        destination: '/docs/foundations',
        permanent: false,
      },
      {
        source: '/docs/getting-started/react-router',
        destination: '/docs/getting-started',
        permanent: false,
      },
      {
        source: '/docs/getting-started/react-router/:path*',
        destination: '/docs/getting-started',
        permanent: false,
      },
      {
        source:
          '/docs/internal/(nitro-native-build|nitro-web-ui|serializable-abort-controller)',
        destination: '/docs/internal',
        permanent: false,
      },
      {
        source: '/docs/observability/(attributes|tracing)',
        destination: '/docs/observability',
        permanent: false,
      },
      // Pages that exist only in v4 (v4 -> v5 switch):
      {
        source: '/v5/docs/api-reference/workflow-runtime/step-entrypoint',
        destination: '/v5/docs/api-reference/workflow-runtime',
        permanent: false,
      },
      // /v5/cookbook/advanced has no index page; fall back to the root.
      {
        source: '/v5/cookbook/advanced/distributed-abort-controller',
        destination: '/v5/cookbook',
        permanent: false,
      },
    ];
  },
};

export default withMDX(config);
