import { createOgImage } from '@/lib/og';

export const GET = async () => {
  return createOgImage({
    title: 'Make any TypeScript Function Durable',
  });
};
