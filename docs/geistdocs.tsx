import type { GeistdocsAgentReadinessConfig } from '@vercel/geistdocs/config';
import { LogoWorkflow } from '@/components/geistcn-fallbacks/geistcn-assets/logos/logo-workflow';

export const Logo = () => <LogoWorkflow height={15} />;

export const github = {
  branch: 'main',
  editPath: 'docs/content/docs/{path}',
  owner: 'vercel',
  repo: 'workflow',
};

export const examplesRepositoryUrl =
  'https://github.com/vercel/workflow-examples';

export const nav: { label: string; href: string; preview?: boolean }[] = [
  {
    label: 'Docs',
    href: '/docs',
  },
  {
    label: 'Cookbook',
    href: '/cookbook',
  },
  {
    label: 'Worlds',
    href: '/worlds',
  },
  {
    label: 'Examples',
    href: examplesRepositoryUrl,
  },
];

export const suggestions = [
  'What is Workflow?',
  'How does retrying work?',
  'What control flow patterns are there?',
  'How do directives work?',
  'How do I build an AI agent?',
];

export const title = 'Workflow SDK Documentation';

export const prompt = `
You are a helpful assistant specializing in answering questions about Workflow, an SDK by Vercel that brings durability, reliability, and observability to async JavaScript. Build apps and AI Agents that can suspend, resume, and maintain state with ease.

Always link to relevant documentation using Markdown with the domain \`workflow-sdk.dev\`. Ensure the link text is descriptive (e.g. [Deploying](https://workflow-sdk.dev/docs/deploying)) and not just the URL.

Politely refuse to respond to queries that do not relate to Vercel or Workflow SDK's documentation, guides, or tools.`;

export const agent = {
  product: {
    name: 'Workflow SDK',
    description:
      'Workflow SDK is a durable functions framework for JavaScript and TypeScript that makes long-running application logic resilient across stateless compute.',
    category: 'Developer tools',
    audience: [
      'JavaScript developers',
      'TypeScript developers',
      'AI agent builders',
    ],
    useCases: [
      'Build durable workflows and steps',
      'Run long-lived AI agents with persisted state',
      'Deploy workflow-backed applications across supported frameworks',
    ],
  },
  links: [
    {
      label: 'Workflow source',
      href: `https://github.com/${github.owner}/${github.repo}`,
      description: 'Source repository for Workflow SDK.',
    },
    {
      label: 'Workflow examples',
      href: examplesRepositoryUrl,
      description: 'Example applications using Workflow SDK.',
    },
  ],
} satisfies GeistdocsAgentReadinessConfig;

export const translations = {
  en: {
    displayName: 'English',
  },
};

export const basePath: string | undefined = undefined;

export const siteId: string | undefined = 'workflow';
