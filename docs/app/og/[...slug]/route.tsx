import type { NextRequest } from 'next/server';
import { getPageImage, source } from '@/lib/geistdocs/source';
import { createOgImage } from '@/lib/og';

export const GET = async (
  _request: NextRequest,
  { params }: RouteContext<'/og/[...slug]'>
) => {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));

  if (!page) {
    return new Response('Not found', { status: 404 });
  }

  return createOgImage({
    title: page.data.title,
    description: page.data.description,
  });
};

export const generateStaticParams = () =>
  source.getPages().map((page) => ({
    slug: getPageImage(page).segments,
  }));
