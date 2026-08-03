import { Feed } from 'feed';
import type { NextRequest } from 'next/server';
import { title } from '@/geistdocs';
import { currentSources } from '@/lib/geistdocs/source';

type PageDataWithLastModified = {
  lastModified?: Date;
};

const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
const host =
  process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL ?? 'localhost:3000';
const baseUrl = `${protocol}://${host}`;

export const revalidate = false;

export const GET = async (
  _req: NextRequest,
  { params }: RouteContext<'/[lang]/rss.xml'>
) => {
  const { lang } = await params;
  const feed = new Feed({
    title,
    id: baseUrl,
    link: baseUrl,
    language: lang,
    copyright: `All rights reserved ${new Date().getFullYear()}, Vercel`,
  });

  for (const source of currentSources) {
    for (const page of source.source.getPages(lang)) {
      const pageData = page.data as typeof page.data & PageDataWithLastModified;

      feed.addItem({
        id: page.url,
        title: page.data.title ?? page.url,
        description: page.data.description ?? '',
        link: `${baseUrl}${page.url}`,
        date: new Date(pageData.lastModified ?? new Date()),
        author: [
          {
            name: 'Vercel',
          },
        ],
      });
    }
  }

  const rss = feed.rss2();

  return new Response(rss, {
    headers: {
      'Content-Type': 'application/rss+xml',
    },
  });
};
