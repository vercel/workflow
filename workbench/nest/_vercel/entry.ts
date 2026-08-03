import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
// Compiled by `nest build` before the Vercel Build Output step runs.
import { AppModule } from '../dist/app.module.js';

let ready: Promise<express.Express> | undefined;

async function createHandler(): Promise<express.Express> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.use(express.json());
  app.use(express.text({ type: 'text/*' }));
  app.use(express.raw({ type: 'application/octet-stream' }));
  await app.init();
  return app.getHttpAdapter().getInstance();
}

export default async function handler(
  req: express.Request,
  res: express.Response
) {
  ready ??= createHandler();
  return (await ready)(req, res);
}
