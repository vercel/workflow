import { registerOTel } from '@vercel/otel';

registerOTel({ serviceName: 'example-nextjs-workflow' });

if (process.env.NEXT_RUNTIME !== 'edge') {
  // kickstart the world
  import('workflow/runtime').then(async ({ getWorld }) => {
    const world = await getWorld();
    if (world.start) {
      console.log('Starting World workers...');
      await world.start();
    }
  });
}
