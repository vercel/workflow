import 'react-router';
import { createRequestHandler } from '@react-router/express';
import express from 'express';

export const app = express();

// Handle all requests with React Router.
// Static file serving is handled by:
// - Vite's dev server in development
// - server.js in production (before mounting this app)
app.all(
  '*',
  createRequestHandler({
    build: () => import('virtual:react-router/server-build'),
  })
);
