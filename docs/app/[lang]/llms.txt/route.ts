import type { NextRequest } from 'next/server';
import {
  getDocsTreeWithoutCookbook,
  rewriteCookbookUrlsInText,
} from '@/lib/geistdocs/cookbook-source';
import { getLLMText, source } from '@/lib/geistdocs/source';

export const revalidate = false;

export const GET = async (
  _req: NextRequest,
  { params }: RouteContext<'/[lang]/llms.txt'>
) => {
  const { lang } = await params;
  const tree = getDocsTreeWithoutCookbook(lang, 'v4');
  const scan = source.getPages(lang).map((page) => getLLMText(page, tree));
  const scanned = await Promise.all(scan);

  return new Response(rewriteCookbookUrlsInText(scanned.join('\n\n')), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
    },
  });
};
