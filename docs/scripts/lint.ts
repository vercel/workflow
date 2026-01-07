import GithubSlugger from 'github-slugger';
import {
  type FileObject,
  printErrors,
  scanURLs,
  validateFiles,
} from 'next-validate-link';
import { source } from '../lib/geistdocs/source';

async function checkLinks() {
  // Pre-fetch all page content and headings
  const pages = await Promise.all(
    source.getPages().map(async (page) => {
      const raw = await page.data.getText('raw');
      return {
        page,
        hashes: getHeadingsFromMarkdown(raw),
      };
    })
  );

  const scanned = await scanURLs({
    preset: 'next',
    populate: {
      'docs/[[...slug]]': pages.map(({ page, hashes }) => ({
        value: {
          slug: page.slugs,
        },
        hashes,
      })),
    },
  });

  const errors = await validateFiles(await getFiles(), {
    scanned,
    markdown: {
      components: {
        Card: { attributes: ['href'] },
      },
    },
    checkRelativePaths: 'as-url',
  });

  printErrors(errors, true);
}

function getHeadingsFromMarkdown(content: string): string[] {
  const slugger = new GithubSlugger();
  const headingRegex = /^#{1,6}\s+(.+)$/gm;
  const headings: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(content)) !== null) {
    const headingText = match[1].trim();
    headings.push(slugger.slug(headingText));
  }

  return headings;
}

function getFiles() {
  const promises = source.getPages().map(
    async (page): Promise<FileObject> => ({
      path: page.absolutePath,
      content: await page.data.getText('raw'),
      url: page.url,
      data: page.data,
    })
  );
  return Promise.all(promises);
}

void checkLinks();
