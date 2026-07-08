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
  basePath,
  siteId,
  translations,
  content: [
    { id: 'docs', label: 'Docs', dir: 'content/docs/v4', route: '/docs' },
    {
      id: 'cookbook',
      label: 'Cookbook',
      dir: 'content/docs/v4/cookbook',
      route: '/cookbook',
    },
    {
      id: 'v5-docs',
      label: 'v5 Docs',
      dir: 'content/docs/v5',
      route: '/v5/docs',
    },
    {
      id: 'v5-cookbook',
      label: 'v5 Cookbook',
      dir: 'content/docs/v5/cookbook',
      route: '/v5/cookbook',
    },
  ],
  versions: {
    current: 'v4',
    items: [
      {
        id: 'v5',
        label: 'v5 (Pre-release)',
        description: 'Workflow 5.x',
        routePrefix: '/v5',
        icon: <IconWorkflow size={20} />,
      },
      {
        id: 'v4',
        label: 'v4 (Latest)',
        description: 'Workflow 4.x',
        icon: <IconWorkflow size={20} />,
      },
    ],
  },
  ai: {
    prompt,
    suggestions,
  },
});
