import { IconWorkflow } from '@vercel/geistdocs/assets/icons/icon-workflow';
import { defineConfig, type GeistdocsNavItem } from '@vercel/geistdocs/config';
import {
  agent,
  basePath,
  github,
  Logo,
  nav,
  prompt,
  siteId,
  suggestions,
  title,
  translations,
} from '@/geistdocs';

const isPreview =
  process.env.VERCEL_ENV === 'preview' ||
  process.env.NODE_ENV === 'development';

const visibleNav: GeistdocsNavItem[] = nav
  .filter((item) => !item.preview || isPreview)
  .map(({ preview: _preview, ...item }) => item);

export const config = defineConfig({
  title,
  agent,
  defaultLanguage: 'en',
  logo: <Logo />,
  github,
  nav: visibleNav,
  // Use the package default OSS product list; just exclude this site's own
  // entry since linking to the site you're already on is redundant.
  navbarActiveProduct: 'workflow-sdk',
  basePath,
  siteId,
  translations,
  content: [
    { id: 'docs', label: 'Docs', dir: 'content/docs/v5', route: '/docs' },
    {
      id: 'cookbook',
      label: 'Cookbook',
      dir: 'content/docs/v5/cookbook',
      route: '/cookbook',
    },
    {
      id: 'v4-docs',
      label: 'v4 Docs',
      dir: 'content/docs/v4',
      route: '/v4/docs',
    },
    {
      id: 'v4-cookbook',
      label: 'v4 Cookbook',
      dir: 'content/docs/v4/cookbook',
      route: '/v4/cookbook',
    },
    {
      id: 'worlds',
      label: 'Worlds',
      dir: 'content/worlds/v5',
      route: '/worlds',
    },
    {
      id: 'v4-worlds',
      label: 'v4 Worlds',
      dir: 'content/worlds/v4',
      route: '/v4/worlds',
    },
  ],
  versions: {
    current: 'v5',
    items: [
      {
        id: 'v5',
        label: 'v5 (Latest)',
        description: 'Workflow 5.x',
        icon: <IconWorkflow size={20} />,
      },
      {
        id: 'v4',
        label: 'v4 (Maintenance)',
        description: 'Workflow 4.x',
        routePrefix: '/v4',
        icon: <IconWorkflow size={20} />,
      },
    ],
  },
  ai: {
    prompt,
    suggestions,
  },
});
