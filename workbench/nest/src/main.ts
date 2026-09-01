import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Configure body parsing similar to express workbench
  // Use dynamic import to work around ESM issues
  const { default: expressModule } = await import('express');
  app.use(expressModule.json());
  app.use(expressModule.text({ type: 'text/*' }));
  app.use(expressModule.raw({ type: 'application/octet-stream' }));

  await app.init();
  if (process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres') {
    const { getWorld } = await import('workflow/runtime');
    console.log('Starting World workers...');
    await (await getWorld()).start?.();
  }

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
}

bootstrap();
