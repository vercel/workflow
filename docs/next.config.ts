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
