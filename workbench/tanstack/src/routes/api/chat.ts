// THIS FILE IS JUST FOR TESTING HMR AS AN ENTRY NEEDS
// TO IMPORT THE WORKFLOWS TO DISCOVER THEM AND WATCH

import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start';
import * as workflows from '../../workflows/3_streams.js';

export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        console.log(workflows);
        return json('hello world');
      },
    },
  },
});
