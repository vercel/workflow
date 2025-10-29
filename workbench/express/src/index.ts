import express from 'express';
import { fromNodeHandler } from 'h3';
import { start } from 'workflow/api';
import { handleUserSignup } from '../workflows/user-signup';

const app = express();

app.post('/api/signup', async (req, res, next) => {
  await start(handleUserSignup, ['test@example.com']);
  return res.json({
    message: 'User signup workflow started',
  });
});

export default fromNodeHandler(app);
