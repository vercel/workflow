import type { NextRequest } from 'next/server';
import { createOgImage } from '@/lib/og';
import { getRegistryItem, getRegistryItemIds } from '@/lib/patterns/manifest';

export const GET = async (
  _request: NextRequest,
  { params }: RouteContext<'/og/patterns/[id]'>
) => {
  const { id } = await params;
  const item = getRegistryItem(id);

  if (!item) {
    return new Response('Not found', { status: 404 });
  }

  return createOgImage({
    title: item.name,
    description: item.description,
  });
};

export const generateStaticParams = () =>
  getRegistryItemIds().map((id) => ({ id }));
