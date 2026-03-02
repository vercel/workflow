import { createOgImage } from '@/lib/og';

export const GET = async () => {
  return createOgImage({
    title: 'Worlds',
    description:
      'The World abstraction allows workflows to run anywhere — locally, on Vercel, or on any cloud.',
  });
};
