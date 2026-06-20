import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // Start the World once at server boot so in-flight runs are recovered after a
  // restart without needing a workflow operation. No-op on the Vercel World;
  // runs recovery for the local/postgres worlds.
  const { ensureWorldStarted } = await import('workflow/runtime');
  await ensureWorldStarted();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Configure body parsing similar to express workbench
  // Use dynamic import to work around ESM issues
  const { default: expressModule } = await import('express');
  app.use(expressModule.json());
  app.use(expressModule.text({ type: 'text/*' }));
  app.use(expressModule.raw({ type: 'application/octet-stream' }));

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
}

bootstrap();
