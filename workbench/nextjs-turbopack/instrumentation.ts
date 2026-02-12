import { registerOTel } from '@vercel/otel';

registerOTel({ serviceName: 'example-nextjs-workflow' });
