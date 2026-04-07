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

// Safety-net error handler — prevents unhandled errors from crashing the
// server when the React Router error boundary cannot render (e.g. during SSR).
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error('Unhandled request error:', err);
    if (!res.headersSent) {
      res.status(500).send('Internal Server Error');
    }
  }
);
