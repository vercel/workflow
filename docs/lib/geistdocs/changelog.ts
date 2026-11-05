import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createChangesetsChangelogSource } from '@vercel/geistdocs/changelog';
import { config } from './config';

const readChangelog = () =>
  readFile(
    path.join(process.cwd(), '..', 'packages', 'workflow', 'CHANGELOG.md'),
    'utf8'
  );

export const changelogOptions = {
  config,
  source: createChangesetsChangelogSource({ read: readChangelog }),
  path: '/changelog',
  markdownPath: '/changelog.md',
  pageSize: 10,
  title: 'Workflow SDK Changelog',
  description: 'The latest Workflow SDK releases, improvements, and fixes.',
};
