import { LogoWorkflow } from '@/components/geistcn-fallbacks/geistcn-assets/logos/logo-workflow';

export const Logo = () => <LogoWorkflow height={15} />;

export const github = {
  owner: 'vercel',
  repo: 'workflow',
};

export const nav = [
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
    href: 'https://github.com/vercel/workflow-examples',
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

export const translations = {
  en: {
    displayName: 'English',
  },
};

export const basePath: string | undefined = undefined;

export const siteId: string | undefined = 'workflow';
