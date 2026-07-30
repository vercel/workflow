import type { NextRequest } from 'next/server';
import { getRegistryItem, getRegistryItemIds } from '@/lib/patterns/manifest';
import { createOgImage } from '@/lib/og';

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
