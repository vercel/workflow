import { registerOTel } from '@vercel/otel';

registerOTel({ serviceName: 'example-workflow' });
