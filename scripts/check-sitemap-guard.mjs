import { execFileSync } from 'node:child_process';

const REQUIRED_FILES = [
  'docs/app/sitemap.md/route.ts',
  'docs/app/[lang]/sitemap.md/route.ts',
  'docs/app/[lang]/llms.mdx/[[...slug]]/route.ts',
];

const readStagedFile = (path) => {
  try {
    return execFileSync('git', ['show', `:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
};

const errors = [];

for (const path of REQUIRED_FILES) {
  const content = readStagedFile(path);
  if (content === null) {
    errors.push(`Missing required staged file: ${path}`);
  }
}

const llmsRoute = readStagedFile(
  'docs/app/[lang]/llms.mdx/[[...slug]]/route.ts'
);
if (llmsRoute !== null) {
  if (!llmsRoute.includes('## Sitemap')) {
    errors.push(
      'LLM route must include a "## Sitemap" section in docs/app/[lang]/llms.mdx/[[...slug]]/route.ts'
    );
  }
  if (!llmsRoute.includes('sitemap.md')) {
    errors.push(
      'LLM route must include a sitemap link pointing to sitemap.md in docs/app/[lang]/llms.mdx/[[...slug]]/route.ts'
    );
  }
}

if (errors.length > 0) {
  console.error('Sitemap guard failed:\n');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}
